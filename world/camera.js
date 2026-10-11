// Camera math in world pixels. A camera's x/y is the world point drawn at the viewport's top-left corner.
export const zoomFor = (viewport, tileSize) => Math.max(0.6, Math.min(2, Math.min(viewport.width, viewport.height) / (18 * tileSize)));

// `area` is the part of the world the camera may show, {x = 0, y = 0, width, height} in world pixels.
export function follow(target, viewport, area, zoom) {
  const width = viewport.width / zoom, height = viewport.height / zoom;
  const axis = (point, size, origin, length) => length <= size ? origin - (size - length) / 2 : Math.max(origin, Math.min(point - size / 2, origin + length - size));
  return { x: axis(target.x, width, area.x || 0, area.width), y: axis(target.y, height, area.y || 0, area.height), zoom };
}

export const screenToTile = (camera, px, py, tileSize) => ({ x: Math.floor((camera.x + px / camera.zoom) / tileSize), y: Math.floor((camera.y + py / camera.zoom) / tileSize) });
export const tileCenter = (tile, tileSize) => ({ x: (tile.x + 0.5) * tileSize, y: (tile.y + 0.5) * tileSize });
