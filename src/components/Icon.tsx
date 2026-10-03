type IconName = 'telegram' | 'send' | 'arrowLeft' | 'logout' | 'plus' | 'message' | 'check' | 'doubleCheck' | 'alert' | 'arrowDown';

const paths: Record<IconName, string[]> = {
  telegram: ['m21 3-7 18-4-8-7-4 18-6Z', 'm21 3-11 10'],
  send: ['m22 2-7 20-4-9-9-4 20-7Z', 'm22 2-11 11'],
  arrowLeft: ['m12 19-7-7 7-7', 'M5 12h14'],
  logout: ['M9 5H5v14h4', 'M9 12h12', 'm17 8 4 4-4 4'],
  plus: ['M12 5v14', 'M5 12h14'],
  message: ['M21 11.5a8.4 8.4 0 0 1-.9 3.8A8.5 8.5 0 0 1 12.5 20a8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 12.5 3h.5a8.5 8.5 0 0 1 8 8v.5Z'],
  check: ['m5 12 4 4L19 6'],
  doubleCheck: ['m2 12 4 4L16 6', 'm12 15 1 1L23 6'],
  alert: ['M12 9v4', 'M12 17h.01', 'm10.3 3-8.8 15a2 2 0 0 0 1.7 3h17.6a2 2 0 0 0 1.7-3L13.7 3a2 2 0 0 0-3.4 0Z'],
  arrowDown: ['M12 5v14', 'm5 12 7 7 7-7'],
};

// Небольшой общий набор значков обходится без внешних файлов и библиотек.
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name].map((path, index) => <path d={path} key={index} />)}</svg>;
}
