export async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  if (Notification.permission !== 'denied') {
    await Notification.requestPermission();
  }
}

export function showNotification(title: string, body: string, icon = '/Logo.png', url?: string) {
  if (Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, icon });
  if (url) n.onclick = () => { window.focus(); window.location.href = url; };
}
