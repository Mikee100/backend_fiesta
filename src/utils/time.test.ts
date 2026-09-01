import assert from 'node:assert/strict';
import test from 'node:test';
import { businessDay, inBusinessTimezone, BUSINESS_TIMEZONE } from './time';

test('converts UTC appointment times to Nairobi time', () => {
  const appointment = inBusinessTimezone('2026-09-04T21:30:00.000Z');

  assert.equal(BUSINESS_TIMEZONE, 'Africa/Nairobi');
  assert.equal(appointment.format('YYYY-MM-DD HH:mm'), '2026-09-05 00:30');
  assert.equal(appointment.format('dddd'), 'Saturday');
});

test('creates a Nairobi business-day boundary for availability queries', () => {
  const startOfDay = businessDay('2026-09-05').startOf('day');
  const endOfDay = businessDay('2026-09-05').endOf('day');

  assert.equal(startOfDay.toISOString(), '2026-09-04T21:00:00.000Z');
  assert.equal(endOfDay.toISOString(), '2026-09-05T20:59:59.999Z');
});
