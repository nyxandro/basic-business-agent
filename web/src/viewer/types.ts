// What the views of the document viewer share (spec, section 8.27).
export interface ZoomControl {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
}

export interface ViewerFailure {
  code: string;
  message: string;
}
