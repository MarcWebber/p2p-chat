export type NotificationStatus = "off" | "on" | "blocked" | "unsupported" | "requesting";

const PREFERENCE_KEY = "twoonly.notifications.enabled";

export function isReadingRoom(activeRoomId: string, roomId: string) {
  return activeRoomId === roomId && document.visibilityState === "visible" && document.hasFocus();
}

export function createMessageNotifications(options: {
  isReading: (roomId: string) => boolean;
  onOpen: (roomId: string) => void;
  onUnread: (counts: Record<string, number>) => void;
  onStatus: (status: NotificationStatus) => void;
  onNotice: (message: string) => void;
}) {
  const baseTitle = document.title;
  const unread: Record<string, number> = {};
  const notifications = new Map<string, Notification>();
  let enabled = false;
  let disposed = false;
  let requesting = false;
  let unavailable = false;

  const supported = () => !unavailable && "Notification" in window && window.isSecureContext;
  const close = (roomId: string) => {
    notifications.get(roomId)?.close();
    notifications.delete(roomId);
  };
  const publish = () => {
    const total = Object.values(unread).reduce((sum, count) => sum + count, 0);
    document.title = total ? `(${total}) ${baseTitle}` : baseTitle;
    options.onUnread({ ...unread });
  };
  const refresh = () => {
    if (disposed) return;
    try { enabled = window.localStorage.getItem(PREFERENCE_KEY) === "true"; } catch { /* Session-only preference. */ }
    options.onStatus(!supported() ? "unsupported"
      : Notification.permission === "denied" ? "blocked"
      : enabled && Notification.permission === "granted" ? "on" : "off");
    if (!enabled || !supported() || Notification.permission !== "granted") {
      for (const roomId of notifications.keys()) close(roomId);
    }
  };
  const forget = (roomId: string) => {
    close(roomId);
    if (!(roomId in unread)) return;
    delete unread[roomId];
    publish();
  };
  refresh();

  return {
    refresh,
    forget,
    markRead(roomId: string) {
      if (!disposed && options.isReading(roomId)) forget(roomId);
    },
    receive(roomId: string) {
      if (disposed || options.isReading(roomId)) return;
      unread[roomId] = (unread[roomId] ?? 0) + 1;
      publish();
      if (!enabled || !supported() || Notification.permission !== "granted") return;
      try {
        close(roomId);
        const notification = new Notification("TwoOnly", {
          body: "收到新消息，点击查看。",
          tag: `twoonly:${roomId}`,
        });
        notifications.set(roomId, notification);
        notification.onclick = () => {
          if (disposed) return;
          window.focus();
          options.onOpen(roomId);
          if (options.isReading(roomId)) forget(roomId);
        };
      } catch {
        // Some browsers expose Notification but require a service worker to display it.
        unavailable = true;
        enabled = false;
        options.onStatus("unsupported");
        options.onNotice("当前浏览器无法弹出系统通知，仍会显示未读数。");
      }
    },
    async toggle() {
      if (disposed || requesting) return;
      if (!supported()) return;
      if (Notification.permission === "denied") {
        options.onNotice("通知被浏览器阻止了，请在地址栏的网站设置中允许通知。");
        return;
      }
      requesting = true;
      options.onStatus("requesting");
      try {
        const permission = Notification.permission === "default"
          ? await Notification.requestPermission() : Notification.permission;
        if (disposed) return;
        enabled = permission === "granted" && !enabled;
        try { window.localStorage.setItem(PREFERENCE_KEY, String(enabled)); } catch { /* Session-only preference. */ }
        refresh();
        options.onNotice(enabled
          ? "消息通知已开启。请保持网页打开；通知不会显示消息正文。"
          : permission === "denied" ? "未获得通知权限，仍会显示未读数。" : "系统通知未开启，仍会显示未读数。");
      } catch {
        if (!disposed) {
          refresh();
          options.onNotice("无法开启系统通知，仍会显示未读数。");
        }
      } finally {
        requesting = false;
      }
    },
    dispose() {
      disposed = true;
      for (const roomId of notifications.keys()) close(roomId);
      document.title = baseTitle;
    },
  };
}
