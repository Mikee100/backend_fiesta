import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreSentiment, circuitBreaker } from './resilience.service';

test('scoreSentiment: neutral message scores non-negative', () => {
  const { score, sentiment } = scoreSentiment('What time do you open?');
  assert.ok(score >= 0, `expected non-negative score, got ${score}`);
  assert.equal(sentiment, 'neutral');
});

test('scoreSentiment: strong negative keyword scores very negative', () => {
  const { score, sentiment } = scoreSentiment('This is a total scam, I want a refund');
  assert.ok(score <= -0.6, `expected score <= -0.6, got ${score}`);
  assert.equal(sentiment, 'very_negative');
});

test('scoreSentiment: mild negative keyword scores negative but not very_negative', () => {
  const { score, sentiment } = scoreSentiment('I am a bit disappointed with the wait');
  assert.ok(score < 0 && score > -0.6, `expected mild negative score, got ${score}`);
  assert.equal(sentiment, 'negative');
});

test('scoreSentiment: excessive exclamation marks and all-caps push the score down', () => {
  const { score } = scoreSentiment('THIS IS RIDICULOUS WHY HASNT ANYONE REPLIED YET');
  assert.ok(score < 0, `expected a negative score from caps + ridiculous keyword, got ${score}`);
});

test('scoreSentiment: positive keyword scores positive', () => {
  const { score, sentiment } = scoreSentiment('Thank you so much, I love the photos!');
  assert.ok(score > 0, `expected a positive score, got ${score}`);
  assert.ok(sentiment === 'positive' || sentiment === 'very_positive', `expected positive sentiment, got ${sentiment}`);
});

test('scoreSentiment: enthusiastic punctuation on a positive message is not punished as frustration', () => {
  const { score, sentiment } = scoreSentiment('Thank you so much!!! This is amazing!!!');
  assert.ok(score > 0, `enthusiastic exclamation marks on positive text should not flip the score negative, got ${score}`);
  assert.notEqual(sentiment, 'negative');
  assert.notEqual(sentiment, 'very_negative');
});

test('circuitBreaker: stays closed below the failure threshold', () => {
  circuitBreaker.recordSuccess(); // reset any state left over from other tests
  assert.equal(circuitBreaker.isOpen(), false);
  circuitBreaker.recordFailure();
  circuitBreaker.recordFailure();
  assert.equal(circuitBreaker.isOpen(), false, 'should not trip after only 2 failures (threshold is 3)');
});

test('circuitBreaker: trips after reaching the failure threshold and blocks calls', () => {
  circuitBreaker.recordSuccess(); // reset
  circuitBreaker.recordFailure();
  circuitBreaker.recordFailure();
  const trippedOnThird = circuitBreaker.recordFailure();
  assert.equal(trippedOnThird, true, 'the third consecutive failure should report that it just tripped the breaker');
  assert.equal(circuitBreaker.isOpen(), true, 'breaker should be open immediately after tripping');
});

test('circuitBreaker: a success resets the failure count', () => {
  circuitBreaker.recordSuccess(); // reset
  circuitBreaker.recordFailure();
  circuitBreaker.recordFailure();
  circuitBreaker.recordSuccess();
  circuitBreaker.recordFailure();
  circuitBreaker.recordFailure();
  assert.equal(circuitBreaker.isOpen(), false, 'failure count should have reset after the success, so two more failures should not trip it');
});
