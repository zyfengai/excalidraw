import { useEffect, useMemo, useRef, useState } from "react";

import { clamp } from "./videoRecorder.utils";

type VideoRecorderTeleprompterProps = {
  text: string;
  speed: number;
  opacity: number;
  running: boolean;
  floating?: boolean;
};

export const VideoRecorderTeleprompter = ({
  text,
  speed,
  opacity,
  running,
  floating = false,
}: VideoRecorderTeleprompterProps) => {
  const [offset, setOffset] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const lastOffsetRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const lines = useMemo(
    () =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    [text],
  );

  useEffect(() => {
    if (!running || lines.length === 0) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      startedAtRef.current = null;
      return;
    }

    const tick = (timestamp: number) => {
      if (startedAtRef.current == null) {
        startedAtRef.current = timestamp;
      }
      const elapsedSec = (timestamp - startedAtRef.current) / 1000;
      const nextOffset = lastOffsetRef.current + elapsedSec * speed;
      setOffset(nextOffset);
      startedAtRef.current = timestamp;
      lastOffsetRef.current = nextOffset;
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      startedAtRef.current = null;
    };
  }, [lines.length, running, speed]);

  useEffect(() => {
    setOffset(0);
    lastOffsetRef.current = 0;
    startedAtRef.current = null;
  }, [text]);

  if (!lines.length) {
    return null;
  }

  return (
    <div
      className={`video-recorder-teleprompter${
        floating ? " video-recorder-teleprompter--floating" : ""
      }`}
      style={{ "--teleprompter-opacity": clamp(opacity, 0.05, 1) } as any}
    >
      <div
        className="video-recorder-teleprompter__content"
        style={{ transform: `translateY(${-offset}px)` }}
      >
        {lines.map((line, idx) => (
          <p key={`${idx}-${line}`}>{line}</p>
        ))}
      </div>
    </div>
  );
};
