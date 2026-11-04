// Shows reminders as notifications, even with the page closed.

self.addEventListener("push", (event) => {
  let message = { title: "Daily", body: "You have a reminder" };
  try {
    message = event.data.json();
  } catch {
    // keep the generic text: a push must always show something
  }
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      icon: "/icon.svg",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (windows[0]) return windows[0].focus();
      return self.clients.openWindow("/");
    })(),
  );
});
