import { useCallback, useEffect, useRef, useState } from "react";

import { CHAT_POLICY } from "@/src/config/policy";
import { readAsDataUrl } from "@/src/utils/browser";
import { formatBytes } from "@/src/utils/format";

type AudioRecorderOptions = {
  sessionKey: string;
  onAudio: (content: string, metadata: { fileSize: number; mimeType: string }) => void | Promise<void>;
  onNotice: (notice: string) => void;
};

export function useAudioRecorder({ sessionKey, onAudio, onNotice }: AudioRecorderOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sessionKeyRef = useRef(sessionKey);
  const onAudioRef = useRef(onAudio);
  const onNoticeRef = useRef(onNotice);

  sessionKeyRef.current = sessionKey;
  onAudioRef.current = onAudio;
  onNoticeRef.current = onNotice;

  const cancelRecording = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.onstop = null;
      if (recorder.state === "recording") recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    chunksRef.current = [];
    setIsRecording(false);
  }, []);

  useEffect(() => cancelRecording, [cancelRecording, sessionKey]);

  const startRecording = async () => {
    try {
      const startedInSession = sessionKeyRef.current;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (startedInSession !== sessionKeyRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      chunksRef.current = [];
      const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "";
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        recorderRef.current = null;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];
        stream.getTracks().forEach((track) => track.stop());
        if (streamRef.current === stream) streamRef.current = null;
        setIsRecording(false);
        if (startedInSession !== sessionKeyRef.current) return;
        if (blob.size > CHAT_POLICY.maxAudioBytes) {
          onNoticeRef.current(`录音超过当前 ${formatBytes(CHAT_POLICY.maxAudioBytes)} 限制，请录制更短的语音。`);
          return;
        }
        if (blob.size) await onAudioRef.current(await readAsDataUrl(blob), {
          fileSize: blob.size,
          mimeType: blob.type || "audio/webm",
        });
      };
      recorder.start();
      setIsRecording(true);
      onNoticeRef.current("正在录音，再次点击即可发送。");
    } catch {
      onNoticeRef.current("无法使用麦克风，请在浏览器设置中允许录音权限。");
    }
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };

  return { isRecording, startRecording, stopRecording, cancelRecording };
}
