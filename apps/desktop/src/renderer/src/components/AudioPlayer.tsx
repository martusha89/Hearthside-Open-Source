import { useEffect, useRef, useState } from "react";
import type { AudioSource } from "../lib/audio";
import { FolderIcon, PauseIcon, PlayIcon, Spinner } from "./icons";

/**
 * Hearthside: a voice-note player for audio an agent made, like a messaging
 * app's: a waveform drawn from the audio (click or drag to seek), speed, the
 * words that were spoken, and the file in its folder.
 */

const BARS = 48;
const SPEEDS = [1, 1.5, 2];

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function cleanError(failure: unknown): string {
  return (failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** A steady pseudo-waveform, used until (or instead of) the real one. */
function placeholderPeaks(seed: string): number[] {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return Array.from({ length: BARS }, (_, index) => {
    hash = (hash * 1103515245 + 12345) >>> 0;
    const wave = 0.45 + 0.35 * Math.sin(index / 3.1);
    return Math.max(0.15, Math.min(1, wave + ((hash % 1000) / 1000 - 0.5) * 0.5));
  });
}

function dataUrlBytes(dataUrl: string): ArrayBuffer {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/** Loudness per bar, from the decoded audio. */
async function realPeaks(dataUrl: string): Promise<number[]> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(dataUrlBytes(dataUrl));
    const samples = audio.getChannelData(0);
    const size = Math.max(1, Math.floor(samples.length / BARS));
    const peaks = Array.from({ length: BARS }, (_, bar) => {
      let sum = 0;
      for (let index = bar * size; index < Math.min(samples.length, (bar + 1) * size); index++) sum += samples[index]! * samples[index]!;
      return Math.sqrt(sum / size);
    });
    const loudest = Math.max(...peaks, 0.0001);
    return peaks.map((peak) => Math.max(0.12, peak / loudest));
  } finally {
    void context.close();
  }
}

export function AudioPlayer({ source, label = "Voice message", transcript }: { source: AudioSource; label?: string; transcript?: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(source.kind === "data" ? source.value : null);
  const [peaks, setPeaks] = useState<number[]>(() => placeholderPeaks(source.value));
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [showText, setShowText] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wantPlay = useRef(false);
  const dragging = useRef(false);

  // Files on this computer load straight away, so the waveform and length show before playing.
  useEffect(() => {
    if (source.kind !== "file") return;
    let live = true;
    void window.bridge
      .readAudioFile(source.value)
      .then((url) => live && setSrc(url))
      .catch((failure: unknown) => live && setError(cleanError(failure)));
    return () => {
      live = false;
    };
  }, [source]);

  useEffect(() => {
    if (!src?.startsWith("data:")) return;
    let live = true;
    void realPeaks(src)
      .then((found) => live && setPeaks(found))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [src]);

  useEffect(() => {
    if (src && wantPlay.current && audio.current) {
      wantPlay.current = false;
      void audio.current.play().catch((failure: unknown) => setError(cleanError(failure)));
    }
  }, [src]);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed, src]);

  const toggle = async () => {
    setError(null);
    if (!src) {
      // Web links load only when played, so nothing is fetched just by showing the chat.
      if (source.kind === "url") {
        wantPlay.current = true;
        setLoading(true);
        setSrc(source.value);
      }
      return;
    }
    const element = audio.current;
    if (!element) return;
    if (element.paused) await element.play().catch((failure: unknown) => setError(cleanError(failure)));
    else element.pause();
  };

  const seekTo = (clientX: number, box: DOMRect) => {
    const element = audio.current;
    if (!element || !duration) return;
    const fraction = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
    element.currentTime = fraction * duration;
    setTime(element.currentTime);
  };

  const progress = duration ? time / duration : 0;

  return (
    <div className="grid w-full max-w-md gap-1.5 rounded-2xl border border-border bg-surface-secondary px-3 py-2.5" data-testid="audio-player">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void toggle()}
          aria-label={playing ? "Pause" : "Play"}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-brand-content shadow-sm transition-transform hover:scale-105 active:scale-95"
        >
          {loading ? <Spinner className="h-4 w-4" /> : playing ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="ml-0.5 h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div
            className="flex h-8 cursor-pointer touch-none items-center gap-[2px]"
            role="slider"
            aria-label="Position"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(time)}
            tabIndex={0}
            onKeyDown={(event) => {
              const element = audio.current;
              if (!element) return;
              if (event.key === "ArrowRight") element.currentTime = Math.min(duration, element.currentTime + 5);
              if (event.key === "ArrowLeft") element.currentTime = Math.max(0, element.currentTime - 5);
            }}
            onPointerDown={(event) => {
              dragging.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              seekTo(event.clientX, event.currentTarget.getBoundingClientRect());
            }}
            onPointerMove={(event) => dragging.current && seekTo(event.clientX, event.currentTarget.getBoundingClientRect())}
            onPointerUp={() => {
              dragging.current = false;
            }}
          >
            {peaks.map((peak, index) => (
              <span
                key={index}
                className={`flex-1 rounded-full transition-colors ${(index + 0.5) / BARS <= progress ? "bg-accent" : "bg-ink-900/20"}`}
                style={{ height: `${Math.round(peak * 100)}%` }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 pl-[52px] text-[11px] text-muted">
        <span className="font-medium text-ink-700">{label}</span>
        <span className="tabular-nums">{playing || time > 0 ? `${clock(time)} / ${clock(duration)}` : clock(duration)}</span>
        <span className="flex-1" />
        {transcript && (
          <button type="button" className="hover:text-ink-800 hover:underline" onClick={() => setShowText(!showText)}>
            {showText ? "Hide transcript" : "Transcript"}
          </button>
        )}
        <button
          type="button"
          className="rounded-md px-1.5 py-0.5 tabular-nums hover:bg-ink-900/5 hover:text-ink-800"
          aria-label="Playback speed"
          onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)}
        >
          {speed}×
        </button>
        {source.kind === "file" && (
          <button type="button" className="rounded-md p-0.5 hover:bg-ink-900/5 hover:text-ink-800" aria-label="Show in folder" title="Show in folder" onClick={() => void window.bridge.revealAudioFile(source.value)}>
            <FolderIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {showText && transcript && <p className="pl-[52px] text-xs italic text-ink-700">“{transcript}”</p>}
      {error && <p className="pl-[52px] text-xs text-error">{error}</p>}
      {src && (
        <audio
          ref={audio}
          src={src}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onPlaying={() => setLoading(false)}
          onEnded={() => {
            setPlaying(false);
            setTime(0);
          }}
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          onError={() => {
            setLoading(false);
            setError("Couldn't play this audio.");
          }}
        />
      )}
    </div>
  );
}
