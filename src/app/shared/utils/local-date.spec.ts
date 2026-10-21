import { todayLocalDateString } from './local-date';

describe('todayLocalDateString', () => {
  it('usa la fecha local, no la UTC', () => {
    // 20:30 hora local: en UTC-6 ya es el día siguiente en UTC.
    expect(todayLocalDateString(new Date(2026, 9, 21, 20, 30))).toBe('2026-10-21');
  });

  it('rellena mes y día de un dígito', () => {
    expect(todayLocalDateString(new Date(2026, 0, 5, 9, 0))).toBe('2026-01-05');
  });
});
