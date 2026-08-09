import { createClient } from "@supabase/supabase-js";

import { isSignalMessage, type SignalMessage, type SignalStatus } from "@/src/signal/types";

type SignalTransportOptions = {
  roomId: string;
  onMessage: (message: SignalMessage) => void;
  onStatus: (status: SignalStatus) => void;
};

export type SignalTransport = {
  start: () => void;
  send: (message: SignalMessage) => void;
  dispose: () => void;
};

export function hasRemoteSignaling() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}

export function createSignalTransport({ roomId, onMessage, onStatus }: SignalTransportOptions): SignalTransport {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (supabaseUrl && supabaseKey) {
    const client = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
    const channel = client.channel(`twoonly:${roomId}`, {
      config: { broadcast: { ack: true } },
    });
    channel.on("broadcast", { event: "signal" }, ({ payload }) => {
      if (isSignalMessage(payload)) onMessage(payload);
    });

    return {
      start() {
        channel.subscribe((status) => {
          if (status === "SUBSCRIBED") onStatus("subscribed");
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") onStatus("unavailable");
        });
      },
      send(message) {
        void channel.send({ type: "broadcast", event: "signal", payload: message });
      },
      dispose() {
        void client.removeChannel(channel);
      },
    };
  }

  const channel = new BroadcastChannel(`twoonly-signal:${roomId}`);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (isSignalMessage(event.data)) onMessage(event.data);
  };

  return {
    start() {
      onStatus("subscribed");
    },
    send(message) {
      channel.postMessage(message);
    },
    dispose() {
      channel.close();
    },
  };
}
