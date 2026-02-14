import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VideoRecorderControlBar } from "../components/video-recorder/VideoRecorderControlBar";
import { getDefaultVideoRecorderSettings } from "../components/video-recorder/videoRecorder.config";

import type { VideoRecorderResult } from "../components/video-recorder/videoRecorder.types";

vi.mock("@excalidraw/excalidraw/i18n", () => {
  const dictionary: Record<string, string> = {
    "videoRecorder.actions.pauseRecording": "Pause recording",
    "videoRecorder.actions.resumeRecording": "Resume recording",
    "videoRecorder.actions.stopRecording": "Stop recording",
    "videoRecorder.actions.download": "Download",
    "videoRecorder.actions.recordAgain": "Record again",
    "videoRecorder.messages.completed": "Completed",
    "buttons.close": "Close",
  };

  const translate = (key: string) => dictionary[key] ?? key;

  return {
    t: translate,
    useI18n: () => ({ t: translate, langCode: "en" }),
  };
});

const createResult = (durationMs: number): VideoRecorderResult => ({
  blob: new Blob(["video"], { type: "video/webm" }),
  mimeType: "video/webm",
  durationMs,
  createdAt: 123,
});

const renderControlBar = (
  opts: Partial<{
    status: "idle" | "recording" | "paused" | "completed";
    elapsedMs: number;
    result: VideoRecorderResult | null;
    teleprompterEnabled: boolean;
    teleprompterText: string;
    onPause: ReturnType<typeof vi.fn>;
    onResume: ReturnType<typeof vi.fn>;
    onStop: ReturnType<typeof vi.fn>;
    onDownload: ReturnType<typeof vi.fn>;
    onOpenDialog: ReturnType<typeof vi.fn>;
    onReset: ReturnType<typeof vi.fn>;
  }> = {},
) => {
  const onPause = opts.onPause ?? vi.fn();
  const onResume = opts.onResume ?? vi.fn();
  const onStop = opts.onStop ?? vi.fn();
  const onDownload = opts.onDownload ?? vi.fn();
  const onOpenDialog = opts.onOpenDialog ?? vi.fn();
  const onReset = opts.onReset ?? vi.fn();

  const settings = {
    ...getDefaultVideoRecorderSettings(),
    teleprompter: {
      ...getDefaultVideoRecorderSettings().teleprompter,
      enabled: opts.teleprompterEnabled ?? false,
      text: opts.teleprompterText ?? "",
    },
  };

  const rendered = render(
    <VideoRecorderControlBar
      status={opts.status ?? "idle"}
      elapsedMs={opts.elapsedMs ?? 0}
      settings={settings}
      result={opts.result ?? null}
      onOpenDialog={onOpenDialog}
      onPause={onPause}
      onResume={onResume}
      onStop={onStop}
      onDownload={onDownload}
      onReset={onReset}
    />,
  );

  return {
    rendered,
    onPause,
    onResume,
    onStop,
    onDownload,
    onOpenDialog,
    onReset,
  };
};

describe("VideoRecorderControlBar", () => {
  it("renders nothing when no active session or result", () => {
    const { rendered } = renderControlBar({
      status: "idle",
      result: null,
    });

    expect(rendered.container.firstChild).toBeNull();
  });

  it("renders nothing for completed status without result payload", () => {
    const { rendered } = renderControlBar({
      status: "completed",
      result: null,
    });

    expect(rendered.container.firstChild).toBeNull();
  });

  it("renders recording controls and supports pause/stop", () => {
    const { onPause, onStop } = renderControlBar({
      status: "recording",
      elapsedMs: 65_000,
    });

    expect(screen.getByText("01:05")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Pause recording/i }));
    fireEvent.click(screen.getByRole("button", { name: /Stop recording/i }));

    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows paused controls and floating teleprompter text", () => {
    const { onResume } = renderControlBar({
      status: "paused",
      elapsedMs: 9_000,
      teleprompterEnabled: true,
      teleprompterText: "line one\nline two",
    });

    expect(
      screen.getByRole("button", { name: /Resume recording/i }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Pause recording/i }),
    ).toBeNull();
    expect(screen.getByText("line one")).toBeVisible();
    expect(screen.getByText("line two")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Resume recording/i }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("does not render teleprompter overlay for empty prompt text", () => {
    renderControlBar({
      status: "paused",
      teleprompterEnabled: true,
      teleprompterText: "   ",
    });

    expect(screen.queryByText("line one")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Resume recording/i }),
    ).toBeVisible();
  });

  it("renders completed actions with duration and supports reset flow", () => {
    const { onDownload, onOpenDialog, onReset } = renderControlBar({
      status: "completed",
      result: createResult(3_723_000),
    });

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("1:02:03")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Download/i }));
    fireEvent.click(screen.getByRole("button", { name: /Record again/i }));
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));

    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onOpenDialog).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
