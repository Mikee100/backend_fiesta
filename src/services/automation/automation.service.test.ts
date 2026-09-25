import assert from 'node:assert/strict';
import test from 'node:test';
import dayjs from 'dayjs';

test('follow-up is due one day after the session time, not at midnight', () => {
  const sessionTime = dayjs('2026-09-25T15:00:00+03:00');
  const followupTime = sessionTime.add(1, 'day');

  assert.equal(followupTime.format('YYYY-MM-DD HH:mm'), '2026-09-26 15:00');
});