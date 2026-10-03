export function normalizePhoneNumber(value: string): string {
  const phone = value.trim().replace(/[\s()-]/g, '').replace(/^\+/, '');
  if (!/^[1-9]\d{6,14}$/.test(phone)) {
    throw new Error('Введите номер с кодом страны: от 7 до 15 цифр.');
  }
  return phone;
}

export function formatPhoneNumber(phone: string): string {
  if (/^7\d{10}$/.test(phone)) {
    return `+7 ${phone.slice(1, 4)} ${phone.slice(4, 7)} ${phone.slice(7, 9)} ${phone.slice(9)}`;
  }
  return phone ? `+${phone}` : '';
}
