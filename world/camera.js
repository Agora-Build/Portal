// Camera math in world pixels. A camera's x/y is the world point drawn at the viewport's top-left corner.
export const zoomFor = (viewport, tileSize) => Math.max(0.6, Math.min(2, Math.min(viewport.width, viewport.height) / (12 * tileSize)));

export function follow(target, viewport, world, zoom) {
  const width = viewport.width / zoom, height = viewport.height / zoom;
  const axis = (point, size, length) => length <= size ? -(size - length) / 2 : Math.max(0, Math.min(point - size / 2, length - size));
  return { x: axis(target.x, width, world.width), y: axis(target.y, height, world.height), zoom };
}

export const screenToTile = (camera, px, py, tileSize) => ({ x: Math.floor((camera.x + px / camera.zoom) / tileSize), y: Math.floor((camera.y + py / camera.zoom) / tileSize) });
export const tileCenter = (tile, tileSize) => ({ x: (tile.x + 0.5) * tileSize, y: (tile.y + 0.5) * tileSize });
