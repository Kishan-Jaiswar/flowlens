import { describe, expect, it } from 'vitest';
import {
  plainCondition,
  plainFallback,
  plainQuestion,
  plainResult,
  plainValue,
} from '../packages/core/src/flow/plainwords.js';

/**
 * Plain words for code, read from its syntax only. The cases are written in
 * no project's vocabulary on purpose: the rules have to hold for any code.
 */
describe('plain questions', () => {
  it.each([
    ['isLoading || !data', 'It is loading, or there is no data?'],
    ['user', 'Is there a user?'],
    ['!items.length', 'Are there no items?'],
    ['cart.items.length === 0', 'Are there no cart items?'],
    ['order.total > 100', 'Is the order total more than 100?'],
    ['age >= MIN_AGE', 'Is the age at least the min age?'],
    ['status === "paid"', 'Is the status "paid"?'],
    ['role !== "admin"', 'Is the role not "admin"?'],
    ['value === undefined || value === null || value === ""', 'Is the value missing or empty?'],
    ['typeof window === "undefined"', 'Is it running outside the browser?'],
    ['"error" in result', 'Is there an error?'],
    ['err instanceof Error', 'Is the error an error?'],
    ['query.category', 'Is the category given?'],
    ['input.email?.trim()', 'Is the email filled in?'],
    ['res.ok', 'Did the response work?'],
    ['form.isSubmitting', 'Is it submitting?'],
    ['canEdit', 'Can it edit?'],
    ['open', 'Is it open?'],
    ['seen.has(id)', 'Does the seen have the id?'],
    ['tags.includes(tag)', 'Does the tags include the tag?'],
    ['EMAIL_RE.test(email)', 'Does the email match the email re pattern?'],
    ['Number.isNaN(price)', 'Is the price not a valid number?'],
    ['qty < 0', 'Is the quantity less than 0?'],
  ])('%s -> %s', (code, words) => {
    expect(plainQuestion(code)).toBe(words);
  });

  it('turns "not (a or b)" into "not a and not b", so yes still means the code holds', () => {
    expect(plainQuestion('!(user || guest)')).toBe('There is no user and there is no guest?');
  });

  it('tells two items of the same list apart', () => {
    expect(plainCondition('rows[i].date < rows[best].date')).toBe(
      'the date of this row is less than the date of the row at best',
    );
  });

  it('keeps the code when a sentence could mislead', () => {
    // Arithmetic, callbacks and mixed and/or have no safe sentence.
    expect(plainQuestion('Date.now() - started > TIMEOUT')).toBeUndefined();
    expect(plainQuestion('rows.every((r) => r.done)')).toBeUndefined();
    expect(plainQuestion('a && (b || c)')).toBeUndefined();
    expect(plainQuestion('x ? y : z')).toBeUndefined();
    expect(plainQuestion('not valid code (')).toBeUndefined();
  });

  it('still names what such a check looks at', () => {
    expect(plainFallback('Date.now() - session.startedAt > SESSION_TTL')).toBe(
      'Does the check on session, started at and session ttl hold?',
    );
  });
});

describe('plain values', () => {
  it.each([
    ['[]', 'an empty list'],
    ['null', 'nothing'],
    ['subtotal + shipping', 'the subtotal plus the shipping'],
    ['Math.max(0, stock - qty)', 'the stock minus the quantity, but never below 0'],
    ['Math.round(done / total * 100)', 'the done divided by the total times 100, rounded'],
    ['"pending"', '"pending"'],
  ])('%s -> %s', (code, words) => {
    expect(plainValue(code)).toBe(words);
  });

  it('says what a function gives back', () => {
    expect(plainResult('{ order, status: "created" }')).toBe('the order and status "created"');
    expect(plainResult('true')).toBe('yes');
    expect(plainResult('[]')).toBe('an empty list');
    expect(plainResult('JSON.parse(text) as Reply')).toBeUndefined();
  });
});
