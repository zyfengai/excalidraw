export type VideoRecorderAspectRatio = "16:9" | "4:3" | "1:1" | "9:16";

export type VideoRecorderResolution = "720p" | "1080p";

export type VideoRecorderCameraShape = "rectangle" | "rounded" | "circle";

export type VideoRecorderStatus =
  | "idle"
  | "preparing"
  | "recording"
  | "paused"
  | "stopping"
  | "completed"
  | "error";

export type VideoRecorderOverlayLayout = {
  /** normalized 0..1 */
  x: number;
  /** normalized 0..1 */
  y: number;
  /** normalized 0..1 */
  width: number;
  /** normalized 0..1 */
  height: number;
  shape: VideoRecorderCameraShape;
};

export type VideoRecorderTeleprompterSettings = {
  enabled: boolean;
  text: string;
  /**
   * 0..1
   */
  opacity: number;
  /**
   * px per second
   */
  speed: number;
};

export type VideoRecorderSettings = {
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
  selectedVideoDeviceId: string | null;
  selectedAudioDeviceId: string | null;
  aspectRatio: VideoRecorderAspectRatio;
  resolution: VideoRecorderResolution;
  fps: number;
  mimeType: string;
  camera: VideoRecorderOverlayLayout;
  teleprompter: VideoRecorderTeleprompterSettings;
};

export type VideoRecorderResult = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  createdAt: number;
};

export type VideoRecorderDeviceOption = {
  deviceId: string;
  label: string;
};

export type VideoRecorderCapabilities = {
  isSupported: boolean;
  reason?: string;
  supportedMimeTypes: string[];
};
