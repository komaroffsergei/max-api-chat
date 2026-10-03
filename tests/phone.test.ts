import { describe, expect, it } from 'vitest';
import { formatPhoneNumber, normalizePhoneNumber } from '../src/phone';

describe('international phone input', () => {
  it.each([
    [' +7 (000) 000-00-01 ', '70000000001'],
    ['+375 (00) 000-00-01', '375000000001'],
    ['1234567', '1234567'],
    ['123456789012345', '123456789012345'],
    ['+44 000 000 0000', '440000000000'],
  ])('normalizes %s without restricting Telegram to MAX countries', (input, normalized) => {
    expect(normalizePhoneNumber(input)).toBe(normalized);
  });

  it.each(['', '  ', '123456', '1234567890123456', '0123456789', '+', '++1234567', '12+34567', '123456x', '123/4567', '@example'])('rejects %j before an API request', input => {
    expect(() => normalizePhoneNumber(input)).toThrow(/номер/);
  });

  it('formats a phone for display while retaining its normalized value', () => {
    expect(formatPhoneNumber('70000000001')).toBe('+7 000 000 00 01');
    expect(formatPhoneNumber('440000000000')).toBe('+440000000000');
    expect(formatPhoneNumber('')).toBe('');
  });
});
