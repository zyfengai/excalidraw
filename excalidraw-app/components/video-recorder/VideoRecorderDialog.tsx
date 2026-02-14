import { useEffect, useRef } from "react";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { Switch } from "@excalidraw/excalidraw/components/Switch";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import { VideoRecorderTeleprompter } from "./VideoRecorderTeleprompter";
import { DEFAULT_VIDEO_RECORDER_CAMERA_LAYOUT } from "./videoRecorder.config";
import {
  clampOverlayLayout,
  normalizeRecorderAspectRatio,
  normalizeRecorderFps,
  normalizeRecorderMimeType,
  normalizeRecorderResolution,
  VIDEO_RECORDER_SUPPORTED_ASPECT_RATIOS,
  VIDEO_RECORDER_SUPPORTED_FPS,
  VIDEO_RECORDER_SUPPORTED_RESOLUTIONS,
  VIDEO_RECORDER_RATIO_MAP,
} from "./videoRecorder.utils";

import type { PointerEvent as ReactPointerEvent } from "react";

import type {
  VideoRecorderCapabilities,
  VideoRecorderDeviceOption,
  VideoRecorderOverlayLayout,
  VideoRecorderSettings,
  VideoRecorderStatus,
} from "./videoRecorder.types";

type VideoRecorderDialogProps = {
  isOpen: boolean;
  capabilities: VideoRecorderCapabilities;
  status: VideoRecorderStatus;
  error: string | null;
  settings: VideoRecorderSettings;
  devices: {
    videoInputs: VideoRecorderDeviceOption[];
    audioInputs: VideoRecorderDeviceOption[];
  };
  onClose: () => void;
  onRefreshDevices: () => Promise<void>;
  onStart: () => Promise<void>;
  onRequestPermissions: () => Promise<void>;
  isRequestingPermissions: boolean;
  onSettingsChange: (
    next:
      | Partial<VideoRecorderSettings>
      | ((prev: VideoRecorderSettings) => VideoRecorderSettings),
  ) => void;
  onCameraLayoutChange: (
    next:
      | Partial<VideoRecorderOverlayLayout>
      | ((prev: VideoRecorderOverlayLayout) => VideoRecorderOverlayLayout),
  ) => void;
};

type InteractionState = {
  mode: "drag" | "resize";
  pointerId: number | null;
  startX: number;
  startY: number;
  startLayout: VideoRecorderOverlayLayout;
  containerWidth: number;
  containerHeight: number;
};

export const VideoRecorderDialog = ({
  isOpen,
  capabilities,
  status,
  error,
  settings,
  devices,
  onClose,
  onRefreshDevices,
  onStart,
  onRequestPermissions,
  isRequestingPermissions,
  onSettingsChange,
  onCameraLayoutChange,
}: VideoRecorderDialogProps) => {
  const { t } = useI18n();
  const previewRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<InteractionState | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      void onRefreshDevices();
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, onRefreshDevices]);

  useEffect(() => {
    if (!settings.cameraEnabled) {
      interactionRef.current = null;
    }
  }, [settings.cameraEnabled]);

  useEffect(() => {
    if (!isOpen || !settings.cameraEnabled) {
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) {
        return;
      }
      if (interaction.pointerId !== null) {
        if (
          !Number.isFinite(event.pointerId) ||
          event.pointerId !== interaction.pointerId
        ) {
          return;
        }
      }
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
        return;
      }
      if (event.pointerType === "mouse" && event.buttons === 0) {
        interactionRef.current = null;
        return;
      }

      const deltaX =
        (event.clientX - interaction.startX) / interaction.containerWidth;
      const deltaY =
        (event.clientY - interaction.startY) / interaction.containerHeight;

      let nextLayout = interaction.startLayout;
      if (interaction.mode === "drag") {
        nextLayout = {
          ...nextLayout,
          x: interaction.startLayout.x + deltaX,
          y: interaction.startLayout.y + deltaY,
        };
      } else {
        let nextWidth = interaction.startLayout.width + deltaX;
        let nextHeight = interaction.startLayout.height + deltaY;
        if (interaction.startLayout.shape === "circle") {
          const size = Math.max(nextWidth, nextHeight);
          nextWidth = size;
          nextHeight = size;
        }
        nextLayout = {
          ...nextLayout,
          width: nextWidth,
          height: nextHeight,
        };
      }

      onCameraLayoutChange(clampOverlayLayout(nextLayout));
    };

    const onPointerUp = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) {
        return;
      }
      if (
        interaction.pointerId !== null &&
        Number.isFinite(event.pointerId) &&
        event.pointerId !== interaction.pointerId
      ) {
        return;
      }
      interactionRef.current = null;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      interactionRef.current = null;
    };
  }, [isOpen, onCameraLayoutChange, settings.cameraEnabled]);

  if (!isOpen) {
    return null;
  }

  const normalizedSelectedVideoDeviceId =
    settings.selectedVideoDeviceId?.trim() || null;
  const normalizedSelectedAudioDeviceId =
    settings.selectedAudioDeviceId?.trim() || null;
  const supportedFpsValues = VIDEO_RECORDER_SUPPORTED_FPS;
  const selectedVideoDeviceValue =
    normalizedSelectedVideoDeviceId &&
    devices.videoInputs.some(
      (device) => device.deviceId === normalizedSelectedVideoDeviceId,
    )
      ? normalizedSelectedVideoDeviceId
      : "";
  const selectedAudioDeviceValue =
    normalizedSelectedAudioDeviceId &&
    devices.audioInputs.some(
      (device) => device.deviceId === normalizedSelectedAudioDeviceId,
    )
      ? normalizedSelectedAudioDeviceId
      : "";
  const selectedAspectRatioValue = normalizeRecorderAspectRatio(
    settings.aspectRatio,
    "16:9",
  );
  const aspectRatioValue = VIDEO_RECORDER_RATIO_MAP[selectedAspectRatioValue];
  const selectedResolutionValue = normalizeRecorderResolution(
    settings.resolution,
    "1080p",
  );
  const selectedFpsValue = normalizeRecorderFps(settings.fps, 30);
  const normalizedRequestedMimeType = settings.mimeType.trim();
  const selectedMimeTypeValue =
    normalizeRecorderMimeType(
      settings.mimeType,
      capabilities.supportedMimeTypes,
    ) || normalizedRequestedMimeType;
  const formatMimeTypeOptions =
    capabilities.supportedMimeTypes.length > 0
      ? capabilities.supportedMimeTypes
      : selectedMimeTypeValue
      ? [selectedMimeTypeValue]
      : [];
  const isFormatDisabled =
    !capabilities.isSupported || capabilities.supportedMimeTypes.length === 0;
  const hasActiveRecordingSession =
    status === "preparing" ||
    status === "recording" ||
    status === "paused" ||
    status === "stopping";
  const isPermissionActionDisabled =
    !capabilities.isSupported ||
    isRequestingPermissions ||
    hasActiveRecordingSession;
  const isStartDisabled =
    !capabilities.isSupported ||
    isRequestingPermissions ||
    hasActiveRecordingSession;

  const startInteraction = (
    mode: InteractionState["mode"],
    event: ReactPointerEvent,
  ) => {
    if (!event.isPrimary) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const container = previewRef.current;
    if (!container) {
      return;
    }
    const containerRect = container.getBoundingClientRect();
    if (
      !Number.isFinite(containerRect.width) ||
      !Number.isFinite(containerRect.height) ||
      containerRect.width <= 0 ||
      containerRect.height <= 0
    ) {
      return;
    }
    interactionRef.current = {
      mode,
      pointerId: Number.isFinite(event.pointerId) ? event.pointerId : null,
      startX: event.clientX,
      startY: event.clientY,
      startLayout: settings.camera,
      containerWidth: containerRect.width,
      containerHeight: containerRect.height,
    };
  };

  return (
    <Dialog
      size="wide"
      onCloseRequest={onClose}
      title={t("videoRecorder.title")}
      className="video-recorder-dialog"
    >
      <div className="video-recorder-dialog__content">
        {!capabilities.isSupported && (
          <div className="video-recorder-dialog__unsupported">
            {t("videoRecorder.errors.notSupported")}
          </div>
        )}
        {error && <div className="video-recorder-dialog__error">{error}</div>}

        <div className="video-recorder-dialog__columns">
          <div className="video-recorder-dialog__settings">
            <h3>{t("videoRecorder.sections.devices")}</h3>
            <div className="video-recorder-dialog__setting">
              <label>{t("videoRecorder.devicePermissions.label")}</label>
              <FilledButton
                variant="outlined"
                label={t("videoRecorder.actions.requestPermissions")}
                onClick={() => {
                  void onRequestPermissions();
                }}
                disabled={isPermissionActionDisabled}
              >
                {t("videoRecorder.actions.requestPermissions")}
              </FilledButton>
            </div>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-camera-enabled">
                {t("videoRecorder.camera.enabled")}
              </label>
              <Switch
                name="video-recorder-camera-enabled"
                checked={settings.cameraEnabled}
                onChange={(checked) =>
                  onSettingsChange({ cameraEnabled: checked })
                }
              />
            </div>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-camera-device">
                {t("videoRecorder.camera.device")}
              </label>
              <select
                id="video-recorder-camera-device"
                className="TextInput"
                value={selectedVideoDeviceValue}
                onChange={(event) =>
                  onSettingsChange({
                    selectedVideoDeviceId: event.target.value || null,
                  })
                }
                disabled={!settings.cameraEnabled}
              >
                <option value="">{t("videoRecorder.defaults.auto")}</option>
                {devices.videoInputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-camera-shape">
                {t("videoRecorder.camera.shape")}
              </label>
              <select
                id="video-recorder-camera-shape"
                className="TextInput"
                value={settings.camera.shape}
                onChange={(event) => {
                  const shape = event.target
                    .value as VideoRecorderOverlayLayout["shape"];
                  if (shape === "circle") {
                    const size = Math.max(
                      settings.camera.width,
                      settings.camera.height,
                    );
                    onCameraLayoutChange({
                      shape,
                      width: size,
                      height: size,
                    });
                    return;
                  }

                  onCameraLayoutChange({ shape });
                }}
                disabled={!settings.cameraEnabled}
              >
                <option value="rectangle">
                  {t("videoRecorder.camera.shapeRectangle")}
                </option>
                <option value="rounded">
                  {t("videoRecorder.camera.shapeRounded")}
                </option>
                <option value="circle">
                  {t("videoRecorder.camera.shapeCircle")}
                </option>
              </select>
            </div>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-camera-width">
                {t("videoRecorder.camera.sizeWidth")} (
                {Math.round(settings.camera.width * 100)}%)
              </label>
              <input
                id="video-recorder-camera-width"
                type="range"
                min={10}
                max={80}
                step={1}
                value={Math.round(settings.camera.width * 100)}
                onChange={(event) => {
                  const width = Number(event.target.value) / 100;
                  if (settings.camera.shape === "circle") {
                    onCameraLayoutChange({ width, height: width });
                  } else {
                    onCameraLayoutChange({ width });
                  }
                }}
                disabled={!settings.cameraEnabled}
              />
            </div>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-camera-height">
                {t("videoRecorder.camera.sizeHeight")} (
                {Math.round(settings.camera.height * 100)}%)
              </label>
              <input
                id="video-recorder-camera-height"
                type="range"
                min={10}
                max={80}
                step={1}
                value={Math.round(settings.camera.height * 100)}
                onChange={(event) => {
                  const height = Number(event.target.value) / 100;
                  if (settings.camera.shape === "circle") {
                    onCameraLayoutChange({ width: height, height });
                  } else {
                    onCameraLayoutChange({ height });
                  }
                }}
                disabled={!settings.cameraEnabled}
              />
            </div>
            <div className="video-recorder-dialog__setting">
              <label>{t("videoRecorder.camera.layout")}</label>
              <FilledButton
                variant="outlined"
                label={t("videoRecorder.camera.resetLayout")}
                onClick={() => {
                  const { x, y, width, height } =
                    DEFAULT_VIDEO_RECORDER_CAMERA_LAYOUT;
                  onCameraLayoutChange({ x, y, width, height });
                }}
                disabled={!settings.cameraEnabled}
              >
                {t("videoRecorder.camera.resetLayout")}
              </FilledButton>
            </div>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-mic-enabled">
                {t("videoRecorder.microphone.enabled")}
              </label>
              <Switch
                name="video-recorder-mic-enabled"
                checked={settings.microphoneEnabled}
                onChange={(checked) =>
                  onSettingsChange({ microphoneEnabled: checked })
                }
              />
            </div>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-mic-device">
                {t("videoRecorder.microphone.device")}
              </label>
              <select
                id="video-recorder-mic-device"
                className="TextInput"
                value={selectedAudioDeviceValue}
                onChange={(event) =>
                  onSettingsChange({
                    selectedAudioDeviceId: event.target.value || null,
                  })
                }
                disabled={!settings.microphoneEnabled}
              >
                <option value="">{t("videoRecorder.defaults.auto")}</option>
                {devices.audioInputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </div>

            <h3>{t("videoRecorder.sections.video")}</h3>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-aspect-ratio">
                {t("videoRecorder.video.aspectRatio")}
              </label>
              <select
                id="video-recorder-aspect-ratio"
                className="TextInput"
                value={selectedAspectRatioValue}
                onChange={(event) =>
                  onSettingsChange({
                    aspectRatio: event.target
                      .value as VideoRecorderSettings["aspectRatio"],
                  })
                }
              >
                {VIDEO_RECORDER_SUPPORTED_ASPECT_RATIOS.map((ratio) => (
                  <option key={ratio} value={ratio}>
                    {ratio}
                  </option>
                ))}
              </select>
            </div>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-resolution">
                {t("videoRecorder.video.resolution")}
              </label>
              <select
                id="video-recorder-resolution"
                className="TextInput"
                value={selectedResolutionValue}
                onChange={(event) =>
                  onSettingsChange({
                    resolution: event.target
                      .value as VideoRecorderSettings["resolution"],
                  })
                }
              >
                {VIDEO_RECORDER_SUPPORTED_RESOLUTIONS.map((resolution) => (
                  <option key={resolution} value={resolution}>
                    {resolution}
                  </option>
                ))}
              </select>
            </div>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-fps">
                {t("videoRecorder.video.fps")}
              </label>
              <select
                id="video-recorder-fps"
                className="TextInput"
                value={selectedFpsValue}
                onChange={(event) =>
                  onSettingsChange({
                    fps: Number(event.target.value),
                  })
                }
              >
                {supportedFpsValues.map((fps) => (
                  <option key={fps} value={fps}>
                    {fps}
                  </option>
                ))}
              </select>
            </div>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-format">
                {t("videoRecorder.video.format")}
              </label>
              <select
                id="video-recorder-format"
                className="TextInput"
                value={selectedMimeTypeValue}
                onChange={(event) =>
                  onSettingsChange({
                    mimeType: event.target.value,
                  })
                }
                disabled={isFormatDisabled}
              >
                {formatMimeTypeOptions.map((mimeType) => (
                  <option key={mimeType} value={mimeType}>
                    {mimeType}
                  </option>
                ))}
              </select>
            </div>

            <h3>{t("videoRecorder.sections.teleprompter")}</h3>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-teleprompter-enabled">
                {t("videoRecorder.teleprompter.enabled")}
              </label>
              <Switch
                name="video-recorder-teleprompter-enabled"
                checked={settings.teleprompter.enabled}
                onChange={(checked) =>
                  onSettingsChange((prev) => ({
                    ...prev,
                    teleprompter: {
                      ...prev.teleprompter,
                      enabled: checked,
                    },
                  }))
                }
              />
            </div>
            <div className="video-recorder-dialog__setting video-recorder-dialog__setting--column">
              <label htmlFor="video-recorder-teleprompter-text">
                {t("videoRecorder.teleprompter.text")}
              </label>
              <textarea
                id="video-recorder-teleprompter-text"
                className="TextInput video-recorder-dialog__textarea"
                value={settings.teleprompter.text}
                onChange={(event) =>
                  onSettingsChange((prev) => ({
                    ...prev,
                    teleprompter: {
                      ...prev.teleprompter,
                      text: event.target.value,
                    },
                  }))
                }
                placeholder={t("videoRecorder.teleprompter.placeholder")}
              />
            </div>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-teleprompter-opacity">
                {t("videoRecorder.teleprompter.opacity")}
              </label>
              <input
                id="video-recorder-teleprompter-opacity"
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={settings.teleprompter.opacity}
                onChange={(event) =>
                  onSettingsChange((prev) => ({
                    ...prev,
                    teleprompter: {
                      ...prev.teleprompter,
                      opacity: Number(event.target.value),
                    },
                  }))
                }
              />
            </div>
            <div className="video-recorder-dialog__setting">
              <label htmlFor="video-recorder-teleprompter-speed">
                {t("videoRecorder.teleprompter.speed")}
              </label>
              <input
                id="video-recorder-teleprompter-speed"
                type="range"
                min={5}
                max={250}
                step={5}
                value={settings.teleprompter.speed}
                onChange={(event) =>
                  onSettingsChange((prev) => ({
                    ...prev,
                    teleprompter: {
                      ...prev.teleprompter,
                      speed: Number(event.target.value),
                    },
                  }))
                }
              />
            </div>
          </div>

          <div className="video-recorder-dialog__preview-column">
            <h3>{t("videoRecorder.preview.title")}</h3>
            <div
              ref={previewRef}
              className="video-recorder-dialog__preview"
              style={
                { "--video-recorder-ratio": String(aspectRatioValue) } as any
              }
            >
              <div className="video-recorder-dialog__preview-canvas" />
              {settings.cameraEnabled && (
                <div
                  className={`video-recorder-dialog__camera-overlay video-recorder-dialog__camera-overlay--${settings.camera.shape}`}
                  style={{
                    left: `${settings.camera.x * 100}%`,
                    top: `${settings.camera.y * 100}%`,
                    width: `${settings.camera.width * 100}%`,
                    height: `${settings.camera.height * 100}%`,
                  }}
                  onPointerDown={(event) => startInteraction("drag", event)}
                >
                  <div className="video-recorder-dialog__camera-label">
                    {t("videoRecorder.preview.camera")}
                  </div>
                  <button
                    type="button"
                    className="video-recorder-dialog__camera-resize-handle"
                    onPointerDown={(event) => startInteraction("resize", event)}
                    aria-label={t("videoRecorder.preview.resizeHandle")}
                  />
                </div>
              )}
            </div>
            <p className="video-recorder-dialog__helper-text">
              {t("videoRecorder.preview.helper")}
            </p>
            <div className="video-recorder-dialog__teleprompter-preview">
              <VideoRecorderTeleprompter
                text={settings.teleprompter.text}
                speed={settings.teleprompter.speed}
                opacity={settings.teleprompter.opacity}
                running={settings.teleprompter.enabled}
              />
            </div>
            <p className="video-recorder-dialog__helper-text">
              {t("videoRecorder.teleprompter.notInOutput")}
            </p>
          </div>
        </div>

        <div className="video-recorder-dialog__actions">
          <FilledButton
            label={t("buttons.cancel")}
            onClick={onClose}
            variant="outlined"
          >
            {t("buttons.cancel")}
          </FilledButton>
          <FilledButton
            label={t("videoRecorder.actions.startRecording")}
            onClick={() => {
              void onStart();
            }}
            disabled={isStartDisabled}
          >
            {t("videoRecorder.actions.startRecording")}
          </FilledButton>
        </div>
      </div>
    </Dialog>
  );
};
