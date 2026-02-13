import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import { VideoRecorderTeleprompter } from "./VideoRecorderTeleprompter";

import type {
  VideoRecorderResult,
  VideoRecorderSettings,
  VideoRecorderStatus,
} from "./videoRecorder.types";

type VideoRecorderControlBarProps = {
  status: VideoRecorderStatus;
  elapsedMs: number;
  settings: VideoRecorderSettings;
  result: VideoRecorderResult | null;
  onOpenDialog: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onDownload: () => void;
  onReset: () => void;
};

const formatDuration = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const twoDigits = (value: number) => String(value).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`;
  }
  return `${twoDigits(minutes)}:${twoDigits(seconds)}`;
};

export const VideoRecorderControlBar = ({
  status,
  elapsedMs,
  settings,
  result,
  onOpenDialog,
  onPause,
  onResume,
  onStop,
  onDownload,
  onReset,
}: VideoRecorderControlBarProps) => {
  const { t } = useI18n();
  const isActive = status === "recording" || status === "paused";

  if (!isActive && !result) {
    return null;
  }

  return (
    <>
      {isActive && settings.teleprompter.enabled && (
        <VideoRecorderTeleprompter
          floating
          text={settings.teleprompter.text}
          speed={settings.teleprompter.speed}
          opacity={settings.teleprompter.opacity}
          running={status === "recording"}
        />
      )}
      <div className="video-recorder-control-bar">
        {isActive ? (
          <>
            <div className="video-recorder-control-bar__status">
              <span
                className={`video-recorder-control-bar__dot${
                  status === "paused"
                    ? " video-recorder-control-bar__dot--paused"
                    : ""
                }`}
              />
              <span>{formatDuration(elapsedMs)}</span>
            </div>
            {status === "recording" ? (
              <FilledButton
                variant="outlined"
                onClick={onPause}
                label={t("videoRecorder.actions.pauseRecording")}
              >
                {t("videoRecorder.actions.pauseRecording")}
              </FilledButton>
            ) : (
              <FilledButton
                onClick={onResume}
                label={t("videoRecorder.actions.resumeRecording")}
              >
                {t("videoRecorder.actions.resumeRecording")}
              </FilledButton>
            )}
            <FilledButton
              color="danger"
              onClick={onStop}
              label={t("videoRecorder.actions.stopRecording")}
            >
              {t("videoRecorder.actions.stopRecording")}
            </FilledButton>
          </>
        ) : (
          <>
            <div className="video-recorder-control-bar__status">
              <span>{t("videoRecorder.messages.completed")}</span>
              <span>{formatDuration(result?.durationMs || 0)}</span>
            </div>
            <FilledButton
              onClick={onDownload}
              label={t("videoRecorder.actions.download")}
            >
              {t("videoRecorder.actions.download")}
            </FilledButton>
            <FilledButton
              variant="outlined"
              onClick={onOpenDialog}
              label={t("videoRecorder.actions.recordAgain")}
            >
              {t("videoRecorder.actions.recordAgain")}
            </FilledButton>
            <FilledButton
              variant="icon"
              onClick={onReset}
              label={t("buttons.close")}
            >
              ✕
            </FilledButton>
          </>
        )}
      </div>
    </>
  );
};
