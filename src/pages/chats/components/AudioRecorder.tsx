import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components";
import { AudioVisualizer } from "@/pages/app/components/speech/audio-visualizer";
import { shouldUsePluelyAPI, fetchSTT } from "@/lib";
import { useApp } from "@/contexts";
import { StopCircle, Send } from "lucide-react";
import { checkLocalProviderSetup } from "@/lib/functions/local-provider-setup.function";

interface AudioRecorderProps {
  onTranscriptionComplete: (text: string) => void;
  onCancel: () => void;
}

const MAX_DURATION = 3 * 60 * 1000;

export const AudioRecorder = ({
  onTranscriptionComplete,
  onCancel,
}: AudioRecorderProps) => {
  const { selectedSttProvider, selectedAIProvider, allSttProviders, selectedAudioDevices } =
    useApp();
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const maxDurationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptionController = useRef<AbortController | null>(null);
  const recordingGeneration = useRef(0);

  // Cleanup function - stops all tracks and clears refs
  const cleanup = useCallback(() => {
    // Clear timers
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    if (maxDurationTimeoutRef.current) {
      clearTimeout(maxDurationTimeoutRef.current);
      maxDurationTimeoutRef.current = null;
    }

    // Stop media recorder
    if (mediaRecorderRef.current?.state === "recording") {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        // Ignore errors when stopping
      }
    }
    mediaRecorderRef.current = null;

    // Stop all audio tracks - this is critical for releasing the microphone
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.stop();
        track.enabled = false;
      });
      streamRef.current = null;
    }

    // Also stop from state
    if (audioStream) {
      audioStream.getTracks().forEach((track) => {
        track.stop();
        track.enabled = false;
      });
    }
    setAudioStream(null);
  }, [audioStream]);

  useEffect(() => {
    startRecording();

    // Cleanup on unmount
    return () => {
      recordingGeneration.current++;
      transcriptionController.current?.abort();
      cleanup();
    };
  }, []);

  const startRecording = async () => {
    const generation = ++recordingGeneration.current;
    try {
      await checkLocalProviderSetup(selectedAIProvider, selectedSttProvider);
      if (generation !== recordingGeneration.current) return;
      const deviceId = selectedAudioDevices?.input?.id;

      const audioConstraints: MediaTrackConstraints =
        deviceId && deviceId !== "default"
          ? { deviceId: { exact: deviceId } }
          : {};

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });
      if (generation !== recordingGeneration.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      // Store in both ref and state
      streamRef.current = stream;
      setAudioStream(stream);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/ogg";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      startTimeRef.current = Date.now();

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.start(100);

      durationIntervalRef.current = setInterval(() => {
        setDuration(Date.now() - startTimeRef.current);
      }, 100);

      maxDurationTimeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") {
          handleSend();
        }
      }, MAX_DURATION);
    } catch (error) {
      if (generation !== recordingGeneration.current) return;
      console.error("Failed to start recording:", error);
      cleanup();
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleStop = () => {
    recordingGeneration.current++;
    transcriptionController.current?.abort();
    cleanup();
    onCancel();
  };

  const handleSend = async () => {
    if (!mediaRecorderRef.current || isTranscribing) return;

    setIsTranscribing(true);
    const controller = new AbortController();
    transcriptionController.current = controller;
    const recorder = mediaRecorderRef.current;
    const mimeType = recorder.mimeType;

    try {
      const chunks = await new Promise<Blob[]>((resolve, reject) => {
        recorder.addEventListener("stop", () => resolve([...audioChunksRef.current]), { once: true });
        recorder.addEventListener("error", () => reject(new Error("Audio recording failed.")), { once: true });
        recorder.stop();
      });
      cleanup();
      if (controller.signal.aborted) return;
      const audioBlob = new Blob(chunks, { type: mimeType });

      const usePluelyAPI = await shouldUsePluelyAPI();
      const provider = allSttProviders.find(
        (p) => p.id === selectedSttProvider.provider
      );

      const text = await fetchSTT({
        provider: usePluelyAPI ? undefined : provider,
        selectedProvider: selectedSttProvider,
        audio: audioBlob,
        signal: controller.signal,
      });

      if (!controller.signal.aborted) onTranscriptionComplete(text);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("Transcription failed:", error);
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTranscribing(false);
    }
  };

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="border bg-background rounded-lg overflow-hidden">
      {error ? <p className="p-3 text-sm text-destructive" role="alert">{error}</p> : null}
      <div className="h-12 relative bg-muted/20">
        {audioStream ? (
          <div className="h-full w-full pt-3">
            <AudioVisualizer stream={audioStream} isRecording={true} />
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            {error ? "Recording stopped" : isTranscribing ? "Transcribing..." : "Initializing..."}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between px-4 py-2.5 border-t bg-muted/5">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 bg-red-500 rounded-full animate-pulse" />
          <span className="text-sm font-mono tabular-nums font-medium">
            {formatTime(duration)}
          </span>
          <span className="text-xs text-muted-foreground">/ 3:00</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="icon"
            variant="outline"
            onClick={handleStop}
            className="h-8 w-8"
            title="Stop recording"
          >
            <StopCircle className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            onClick={handleSend}
            disabled={isTranscribing || !!error}
            className="h-8 w-8"
            title={isTranscribing ? "Sending..." : "Send to AI"}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};
