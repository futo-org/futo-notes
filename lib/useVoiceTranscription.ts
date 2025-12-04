import { useState, useCallback, useEffect, useRef } from "react";
import {
  useAudioRecorder,
  type RecordingConfig,
} from "@siteed/expo-audio-studio";
import { useCactusSTT } from "cactus-react-native";

// Whisper requires 16kHz mono PCM WAV audio
const WHISPER_RECORDING_CONFIG: RecordingConfig = {
  sampleRate: 16000,
  channels: 1,
  encoding: "pcm_16bit",
};

export type VoiceTranscriptionState =
  | "idle"
  | "downloading_model"
  | "initializing"
  | "ready"
  | "recording"
  | "transcribing"
  | "error";

export interface UseVoiceTranscriptionOptions {
  onTranscription?: (text: string) => void;
  onError?: (error: string) => void;
}

export interface UseVoiceTranscriptionReturn {
  state: VoiceTranscriptionState;
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => Promise<void>;
}

export function useVoiceTranscription({
  onTranscription,
  onError,
}: UseVoiceTranscriptionOptions = {}): UseVoiceTranscriptionReturn {
  const [state, setState] = useState<VoiceTranscriptionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const isCancelledRef = useRef(false);

  // Use expo-audio-studio which outputs WAV format
  const {
    startRecording: startAudioRecording,
    stopRecording: stopAudioRecording,
    isRecording,
  } = useAudioRecorder();

  const cactusSTT = useCactusSTT({ model: "whisper-small" });

  // Initialize Cactus STT model
  useEffect(() => {
    let cancelled = false;

    const prepareModel = async () => {
      try {
        // Wait a moment for the isDownloaded check to complete
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (cancelled) return;

        if (!cactusSTT.isDownloaded && !cactusSTT.isDownloading) {
          console.log("Downloading whisper model...");
          setState("downloading_model");
          await cactusSTT.download();
          console.log("Model downloaded");
        }

        if (cancelled) return;

        console.log("Initializing whisper model...");
        setState("initializing");
        await cactusSTT.init();
        console.log("Model initialized");

        if (cancelled) return;

        setModelReady(true);
        setState("ready");
      } catch (e) {
        if (cancelled) return;
        console.error("Model init error:", e);
        const errorMsg =
          e instanceof Error ? e.message : "Failed to initialize model";
        setError(errorMsg);
        setState("error");
        onError?.(errorMsg);
      }
    };

    prepareModel();
    return () => {
      cancelled = true;
    };
  }, []);

  const startRecording = useCallback(async () => {
    console.log("startRecording called, modelReady:", modelReady);

    try {
      setError(null);
      isCancelledRef.current = false;

      if (!modelReady) {
        const errorMsg = "Model not ready yet";
        setError(errorMsg);
        onError?.(errorMsg);
        return;
      }

      console.log("Starting audio recording...");
      await startAudioRecording(WHISPER_RECORDING_CONFIG);
      console.log("Recording started");
      setState("recording");
    } catch (e) {
      console.error("startRecording error:", e);
      const errorMsg =
        e instanceof Error ? e.message : "Failed to start recording";
      setError(errorMsg);
      setState("error");
      onError?.(errorMsg);
    }
  }, [modelReady, startAudioRecording, onError]);

  const stopRecording = useCallback(async () => {
    console.log("stopRecording called");

    try {
      setState("transcribing");

      console.log("Stopping audio recorder...");
      const result = await stopAudioRecording();
      console.log("Recording stopped, result:", result);

      if (isCancelledRef.current) {
        setState("ready");
        return;
      }

      const uri = result?.fileUri;
      if (!uri) {
        throw new Error("No recording URI available");
      }

      console.log("Recording URI:", uri);
      console.log("Starting transcription...");

      const transcriptionResult = await cactusSTT.transcribe({
        audioFilePath: uri,
        onToken: (token) => console.log("Token:", token),
      });
      console.log(
        "Transcription result:",
        JSON.stringify(transcriptionResult, null, 2)
      );

      if (transcriptionResult.success && transcriptionResult.response) {
        // Clean up Whisper control tokens from the response
        const cleanedText = transcriptionResult.response
          .replace(/<\|[^>]+\|>/g, "") // Remove all <|...|> tokens
          .trim();
        onTranscription?.(cleanedText);
      } else {
        throw new Error("Transcription returned no response");
      }

      setState("ready");
    } catch (e) {
      console.error("stopRecording error:", e);
      const errorMsg =
        e instanceof Error ? e.message : "Transcription failed";
      setError(errorMsg);
      setState("error");
      onError?.(errorMsg);
    }
  }, [stopAudioRecording, cactusSTT, onTranscription, onError]);

  const cancelRecording = useCallback(async () => {
    console.log("cancelRecording called");
    isCancelledRef.current = true;
    try {
      await stopAudioRecording();
      setState("ready");
    } catch {
      setState("ready");
    }
  }, [stopAudioRecording]);

  return {
    state,
    error,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
