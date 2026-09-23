/**
 * 文件类型角标：按文件名取 workspaceFileMarker 的色调/缩写，文件树与变更列表共用。
 */
import React, { type ReactElement } from "react";
import { workspaceFileMarker } from "../../workspaceFileMarker.js";

export function FileTypeMarker({ name }: { name: string }): ReactElement {
  const marker = workspaceFileMarker(name);
  return (
    <span aria-hidden="true" className={`file-type-marker is-${marker.tone}${marker.label.length > 2 ? " is-wide" : ""}`}>
      {marker.label}
    </span>
  );
}
