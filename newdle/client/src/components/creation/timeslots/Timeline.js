import React, {useEffect, useState, useRef} from 'react';
import {useDispatch, useSelector} from 'react-redux';
import {Trans, t, plural} from '@lingui/macro';
import _ from 'lodash';
import moment from 'moment';
import PropTypes from 'prop-types';
import TimePicker from 'rc-time-picker';
import {Header, Icon, Popup, Button, Grid} from 'semantic-ui-react';
import {addTimeslot, removeTimeslot, setTimezone} from '../../../actions';
import {
  getCreationCalendarActiveDate,
  getDuration,
  getTimeslotsForActiveDate,
  getNewTimeslotStartTime,
  getPreviousDayTimeslots,
  getTimezone,
  getParticipantAvailability,
} from '../../../selectors';
import {hourRange, toMoment, getHourSpan, DEFAULT_TIME_FORMAT} from '../../../util/date';
import {useIsSmallScreen} from '../../../util/hooks';
import TimezonePicker from '../../common/TimezonePicker';
import CandidatePlaceholder from './CandidatePlaceholder';
import CandidateSlot from './CandidateSlot';
import DurationPicker from './DurationPicker';
import TimelineHeader from './TimelineHeader';
import TimelineRow from './TimelineRow';
import 'rc-time-picker/assets/index.css';
import styles from './Timeline.module.scss';

const OVERFLOW_WIDTH = 0.5;

function calculateWidth(start, end, minHour, maxHour) {
  let startMins = start.hours() * 60 + start.minutes();
  let endMins = end.hours() * 60 + end.minutes();

  startMins = Math.max(startMins, minHour * 60);
  endMins = Math.min(endMins, maxHour * 60);

  if (endMins < startMins) {
    // end is beyond 24:00 of the current day
    endMins = 24 * 60;
  }

  return ((endMins - startMins) / ((maxHour - minHour) * 60)) * 100;
}

function calculatePosition(start, minHour, maxHour) {
  const spanMins = (maxHour - minHour) * 60;
  let startMins = start.hours() * 60 + start.minutes() - minHour * 60;

  if (startMins < 0) {
    startMins = 0;
  }

  const position = (startMins / spanMins) * 100;
  return position < 100 ? position : 100 - OVERFLOW_WIDTH;
}

function getSlotProps(startTime, endTime, minHour, maxHour) {
  const start = toMoment(startTime, DEFAULT_TIME_FORMAT);
  const end = toMoment(endTime, DEFAULT_TIME_FORMAT);
  return {
    startTime,
    endTime,
    width: calculateWidth(start, end, minHour, maxHour),
    pos: calculatePosition(start, minHour, maxHour),
    key: `${startTime}-${endTime}`,
  };
}

function getBusySlotProps(slot, minHour, maxHour) {
  return getSlotProps(slot.startTime, slot.endTime, minHour, maxHour);
}

function getCandidateSlotProps(startTime, duration, minHour, maxHour) {
  const endTime = toMoment(startTime, DEFAULT_TIME_FORMAT)
    .add(duration, 'm')
    .format(DEFAULT_TIME_FORMAT);
  return getSlotProps(startTime, endTime, minHour, maxHour);
}

/**
 * Remove all slots which fall outside [minHour, maxHour] and "trim" those which
 * are partially outside of it.
 */
function trimOverflowingSlots(slots, minHour, maxHour) {
  const minTime = toMoment(`${minHour}:00`, DEFAULT_TIME_FORMAT);
  const maxTime = toMoment(`${maxHour}:00`, DEFAULT_TIME_FORMAT);
  return _.without(
    slots.map(({startTime, endTime}) => {
      startTime = toMoment(startTime, DEFAULT_TIME_FORMAT);
      endTime = toMoment(endTime, DEFAULT_TIME_FORMAT);

      // if startTime > endTime, then we're referring to the next day
      if (startTime.isAfter(endTime)) {
        endTime.add(1, 'd');
      }

      // interval completely outside the hour range
      if (moment(endTime).isBefore(minTime) || moment(startTime).isSameOrAfter(maxTime)) {
        return null;
      }

      startTime = moment.max(startTime, minTime);
      endTime = moment.min(endTime, maxTime);

      return startTime.isSame(endTime)
        ? null
        : {
            startTime: startTime.format(DEFAULT_TIME_FORMAT),
            endTime: endTime.format(DEFAULT_TIME_FORMAT),
          };
    }),
    null
  );
}

function calculateBusyPositions(availability, minHour, maxHour) {
  return availability.map(({participant, busySlotsLoading, busySlots}) => {
    const slots = trimOverflowingSlots(busySlots, minHour, maxHour).map(slot =>
      getBusySlotProps(slot, minHour, maxHour)
    );
    return {
      participant,
      busySlotsLoading,
      busySlots: slots,
    };
  });
}

function splitOverlappingCandidates(candidates, duration) {
  let current = [];
  const groupedCandidates = [];
  const sortedCandidates = candidates.sort();
  for (let i = 0; i < sortedCandidates.length; i++) {
    const candidate = sortedCandidates[i];
    if (i + 1 >= sortedCandidates.length) {
      current.push(candidate);
    } else {
      const endTime = toMoment(candidate, DEFAULT_TIME_FORMAT).add(duration, 'm');
      const nextCandidateStartTime = toMoment(sortedCandidates[i + 1], DEFAULT_TIME_FORMAT);

      if (nextCandidateStartTime.isSameOrBefore(endTime)) {
        groupedCandidates.push([...current, candidate]);
        current = [];
      } else {
        current.push(candidate);
      }
    }
  }
  return [...groupedCandidates, current];
}

function BusyColumn({width, pos}) {
  return <div className={styles['busy-column']} style={{left: `${pos}%`, width: `${width}%`}} />;
}

BusyColumn.propTypes = {
  width: PropTypes.number.isRequired,
  pos: PropTypes.number.isRequired,
};

function TimelineInput({minHour, maxHour}) {
  const dispatch = useDispatch();
  const duration = useSelector(getDuration);
  const date = useSelector(getCreationCalendarActiveDate);
  const candidates = useSelector(getTimeslotsForActiveDate);
  const availability = useSelector(getParticipantAvailability);
  const latestStartTime = useSelector(getNewTimeslotStartTime);
  const [timeslotTime, setTimeslotTime] = useState(latestStartTime);
  const [newTimeslotPopupOpen, setTimeslotPopupOpen] = useState(false);
  const timelineRef = useRef(null);
  // Indicates the position of the mouse in the timeline
  const [candidatePlaceholder, setCandidatePlaceholder] = useState({
    visible: false,
    time: '',
    left: 0,
    width: 0,
  });
  // We don't want to show the tooltip when the mouse is hovering over a slot
  const [isHoveringSlot, setIsHoveringSlot] = useState(false);

  useEffect(() => {
    setTimeslotTime(latestStartTime);
  }, [latestStartTime, candidates, duration]);

  const handlePopupClose = () => {
    setTimeslotPopupOpen(false);
  };

  const handleAddSlot = time => {
    dispatch(addTimeslot(date, time));
  };

  const handleRemoveSlot = (event, time) => {
    dispatch(removeTimeslot(date, time));
    setIsHoveringSlot(false);
  };

  const handleUpdateSlot = (oldTime, newTime) => {
    dispatch(removeTimeslot(date, oldTime));
    dispatch(addTimeslot(date, newTime));
  };

  // Function to check if a time matches any existing timeslot times
  const isTimeSlotTaken = time => {
    return candidates.includes(time);
  };

  function calculatePlaceholderStart(e, minHour, maxHour) {
    const timelineRect = timelineRef.current.getBoundingClientRect();
    const position = (e.clientX - timelineRect.left) / timelineRect.width;
    const totalMinutes = (maxHour - minHour) * 60;

    let minutes = minHour * 60 + position * totalMinutes;
    minutes = Math.floor(minutes / 15) * 15;

    if (position < 0) {
      minutes = 0;
    }

    return moment().startOf('day').add(minutes, 'minutes');
  }

  const handleMouseDown = e => {
    const start = calculatePlaceholderStart(e, minHour, maxHour);
    const formattedTime = start.format(DEFAULT_TIME_FORMAT);
    if (!isTimeSlotTaken(formattedTime)) {
      handleAddSlot(formattedTime);
    }
  };

  /**
   * Tracks the mouse movement in the timeline and updates the candidatePlaceholder state
   * @param {Event} e
   * @returns
   */
  const handleTimelineMouseMove = e => {
    if (isHoveringSlot) {
      setCandidatePlaceholder(p => ({...p, visible: false}));
      return;
    }

    const start = calculatePlaceholderStart(e, minHour, maxHour);
    const end = moment(start).add(duration, 'minutes');
    const time = start.format(DEFAULT_TIME_FORMAT);

    // Check if the time slot is already taken
    if (isTimeSlotTaken(time)) {
      setCandidatePlaceholder(p => ({...p, visible: false}));
      return;
    }

    setCandidatePlaceholder(p => ({
      ...p,
      visible: true,
      time,
      left: calculatePosition(start, minHour, maxHour),
      width: calculateWidth(start, end, minHour, maxHour),
    }));
  };

  const handleTimelineMouseLeave = () => {
    setCandidatePlaceholder(p => ({...p, visible: false}));
  };

  const groupedCandidates = splitOverlappingCandidates(candidates, duration);

  return (
    <div>
      <div
        ref={timelineRef}
        style={{position: 'relative'}}
        className={`${styles['timeline-input']} ${styles['edit']}`}
        onClick={event => {
          handleMouseDown(event);
          handleTimelineMouseLeave();
        }}
        onMouseMove={handleTimelineMouseMove}
        onMouseLeave={handleTimelineMouseLeave}
      >
        <CandidatePlaceholder {...candidatePlaceholder} />
        <div className={styles['timeline-candidates']}>
          {groupedCandidates.map((rowCandidates, i) => (
            <div
              className={styles['candidates-group']}
              key={i}
              onMouseEnter={() => {
                setIsHoveringSlot(true);
              }}
              onMouseLeave={() => {
                setIsHoveringSlot(false);
              }}
            >
              {rowCandidates.map(time => {
                const slotProps = getCandidateSlotProps(time, duration, minHour, maxHour);
                const participants = availability?.find(a => a.startDt === `${date}T${time}`);
                return (
                  <CandidateSlot
                    {...slotProps}
                    key={time}
                    isValidTime={time => !isTimeSlotTaken(time)}
                    onDelete={event => {
                      // Prevent the event from bubbling up to the parent div
                      event.stopPropagation();
                      handleRemoveSlot(event, time);
                    }}
                    onMouseEnter={() => {
                      setIsHoveringSlot(true);
                    }}
                    onMouseLeave={() => {
                      setIsHoveringSlot(false);
                    }}
                    onChangeSlotTime={newStartTime => handleUpdateSlot(time, newStartTime)}
                    text={
                      participants &&
                      plural(participants.availableCount, {
                        0: 'No participants registered',
                        one: '# participant registered',
                        other: '# participants registered',
                      })
                    }
                  />
                );
              })}
            </div>
          ))}
        </div>
        <div onMouseMove={e => e.stopPropagation()} className={styles['add-btn-wrapper']}>
          <Popup
            trigger={
              <Icon
                className={`${styles['clickable']} ${styles['add-btn']}`}
                name="plus circle"
                size="large"
                onMouseMove={e => e.stopPropagation()}
              />
            }
            on="click"
            onMouseMove={e => {
              e.stopPropagation();
            }}
            position="bottom center"
            onOpen={evt => {
              // Prevent the event from bubbling up to the parent div
              evt.stopPropagation();
              setTimeslotPopupOpen(true);
            }}
            onClose={handlePopupClose}
            open={newTimeslotPopupOpen}
            onKeyDown={evt => {
              const canBeAdded = timeslotTime && !isTimeSlotTaken(timeslotTime);
              if (evt.key === 'Enter' && canBeAdded) {
                handleAddSlot(timeslotTime);
                handlePopupClose();
              }
            }}
            className={styles['timepicker-popup']}
            content={
              <div
                // We need a div to attach events
                onClick={e => e.stopPropagation()}
                onMouseMove={e => {
                  e.stopPropagation();
                }}
              >
                <TimePicker
                  showSecond={false}
                  value={toMoment(timeslotTime, DEFAULT_TIME_FORMAT)}
                  format={DEFAULT_TIME_FORMAT}
                  onChange={time => setTimeslotTime(time ? time.format(DEFAULT_TIME_FORMAT) : null)}
                  onMouseMove={e => e.stopPropagation()}
                  allowEmpty={false}
                  // keep the picker in the DOM tree of the surrounding element
                  getPopupContainer={node => node}
                />
                <Button
                  icon
                  onMouseMove={e => e.stopPropagation()}
                  onClick={() => {
                    handleAddSlot(timeslotTime);
                    handlePopupClose();
                  }}
                  disabled={!timeslotTime || isTimeSlotTaken(timeslotTime)}
                >
                  <Icon name="check" onMouseMove={e => e.stopPropagation()} />
                </Button>
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}

TimelineInput.propTypes = {
  minHour: PropTypes.number.isRequired,
  maxHour: PropTypes.number.isRequired,
};

function ClickToAddTimeSlots({startEditing, copyTimeSlots}) {
  const pastCandidates = useSelector(getPreviousDayTimeslots);

  return (
    <div className={styles['timeline-input-wrapper']}>
      <div className={`${styles['timeline-input']} ${styles['msg']}`} onClick={startEditing}>
        <Icon name="plus circle" size="large" />
        <Trans>Click to add time slots</Trans>
      </div>
      {pastCandidates && (
        <div className={`${styles['timeline-input']} ${styles['msg']}`} onClick={copyTimeSlots}>
          <Icon name="copy" size="large" />
          <Trans>Copy time slots from previous day</Trans>
        </div>
      )}
    </div>
  );
}

ClickToAddTimeSlots.propTypes = {
  startEditing: PropTypes.func.isRequired,
  copyTimeSlots: PropTypes.func.isRequired,
};

function TimelineContent({busySlots: allBusySlots, minHour, maxHour}) {
  const dispatch = useDispatch();
  const candidates = useSelector(getTimeslotsForActiveDate);

  const [_editing, setEditing] = useState(false);
  const editing = _editing || !!candidates.length;
  const date = useSelector(getCreationCalendarActiveDate);
  const pastCandidates = useSelector(getPreviousDayTimeslots);

  const copyTimeSlots = () => {
    pastCandidates.forEach(time => {
      dispatch(addTimeslot(date, time));
    });
    setEditing(true);
  };

  return (
    <>
      <div className={styles['timeline-rows']}>
        {allBusySlots.map(slot => (
          <TimelineRow {...slot} key={slot.participant.email} />
        ))}
        {allBusySlots.map(({busySlots, participant}) =>
          busySlots.map(slot => {
            const key = `${participant.email}-${slot.startTime}-${slot.endTime}`;
            return <BusyColumn {...slot} key={key} />;
          })
        )}
        {editing && <TimelineInput minHour={minHour} maxHour={maxHour} />}
        {!editing && (
          <ClickToAddTimeSlots
            startEditing={() => setEditing(true)}
            copyTimeSlots={copyTimeSlots}
          />
        )}
      </div>
      {editing && candidates.length === 0 && (
        <div className={styles['add-first-text']}>
          <Icon name="mouse pointer" />
          <Trans>Click the timeline to add your first time slot</Trans>
        </div>
      )}
    </>
  );
}

TimelineContent.propTypes = {
  busySlots: PropTypes.array.isRequired,
  minHour: PropTypes.number.isRequired,
  maxHour: PropTypes.number.isRequired,
};

export default function Timeline({date, availability, defaultMinHour, defaultMaxHour, hourStep}) {
  const isTabletOrMobile = useIsSmallScreen();
  const [[minHour, maxHour], setHourSpan] = useState([defaultMinHour, defaultMaxHour]);
  const candidates = useSelector(getTimeslotsForActiveDate);
  const duration = useSelector(getDuration);
  const hourSeries = hourRange(minHour, maxHour, hourStep);
  const hourSpan = maxHour - minHour;
  const defaultHourSpan = defaultMaxHour - defaultMinHour;
  const busySlots = calculateBusyPositions(availability, minHour, maxHour);
  const timezone = useSelector(getTimezone);
  const dispatch = useDispatch();

  useEffect(() => {
    if (!candidates.length) {
      setHourSpan([defaultMinHour, defaultMaxHour]);
      return;
    }
    const format = DEFAULT_TIME_FORMAT;
    const input = {
      timeSlots: candidates,
      defaultHourSpan,
      defaultMaxHour,
      defaultMinHour,
      duration,
      format,
    };
    const shouldSpanTwoDays = false;
    setHourSpan(getHourSpan(input, shouldSpanTwoDays));
  }, [candidates, defaultHourSpan, defaultMaxHour, defaultMinHour, duration]);

  const creationTimezone = localStorage.getItem('creationTimezone');
  const revertIcon = (
    <Popup
      trigger={
        <Icon
          name="redo"
          color="white"
          onClick={() => {
            dispatch(setTimezone(moment.tz.guess()));
            localStorage.removeItem('creationTimezone');
          }}
          size="small"
          link
        />
      }
      content={t`Revert to the local timezone`}
      position="bottom center"
    />
  );
  const timezonePickerTitle =
    creationTimezone && moment.tz.guess() !== creationTimezone ? (
      <Trans>Timezone {revertIcon}</Trans>
    ) : (
      t`Timezone`
    );

  return (
    <div className={styles['timeline']}>
      <Grid>
        <Grid.Row className={styles['timeline-title']}>
          <Grid.Column>
            <Grid stackable textAlign={isTabletOrMobile ? 'left' : 'right'}>
              <Grid.Column computer={6} tablet={16}>
                <Header as="h2" className={styles['timeline-date']}>
                  {toMoment(date, 'YYYY-MM-DD').format('D MMM YYYY')}
                </Header>
              </Grid.Column>
              <Grid.Column computer={10} tablet={16}>
                <div className={styles['config-box']}>
                  <DurationPicker />
                  <TimezonePicker
                    onChange={value => {
                      dispatch(setTimezone(value));
                      localStorage.setItem('creationTimezone', value);
                    }}
                    currentTz={timezone}
                    title={timezonePickerTitle}
                    selection
                  />
                </div>
              </Grid.Column>
            </Grid>
          </Grid.Column>
        </Grid.Row>
        <Grid.Row className={styles['timeline-content']}>
          <Grid.Column>
            <div className={styles['timeline-slot-picker']}>
              <TimelineHeader hourSeries={hourSeries} hourSpan={hourSpan} hourStep={hourStep} />
              <TimelineContent busySlots={busySlots} minHour={minHour} maxHour={maxHour} />
            </div>
          </Grid.Column>
        </Grid.Row>
      </Grid>
    </div>
  );
}

Timeline.propTypes = {
  date: PropTypes.string.isRequired,
  availability: PropTypes.array.isRequired,
  defaultMinHour: PropTypes.number,
  defaultMaxHour: PropTypes.number,
  hourStep: PropTypes.number,
};

Timeline.defaultProps = {
  defaultMinHour: 0,
  defaultMaxHour: 24,
  hourStep: 2,
};
