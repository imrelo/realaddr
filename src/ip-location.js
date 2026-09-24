export function rectangleAround(latitude, longitude) {
  // A fixed local viewport, approximately 40 km north/south and east/west.
  const latDelta = 20 / 111.32;
  const lonDelta = Math.min(180, latDelta / Math.max(0.000001, Math.cos(latitude * Math.PI / 180)));
  const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;
  const rectangle = {
    low: { latitude: Math.max(-90, latitude - latDelta), longitude: lonDelta === 180 ? -180 : wrap(longitude - lonDelta) },
    high: { latitude: Math.min(90, latitude + latDelta), longitude: lonDelta === 180 ? 180 : wrap(longitude + lonDelta) }
  };
  return rectangle;
}

export function withinViewport(location, { low, high }) {
  if (!Number.isFinite(location?.latitude) || !Number.isFinite(location?.longitude)) return false;
  const { latitude, longitude } = location;
  return latitude >= low.latitude && latitude <= high.latitude && Math.abs(longitude) <= 180 &&
    (low.longitude <= high.longitude ? longitude >= low.longitude && longitude <= high.longitude : longitude >= low.longitude || longitude <= high.longitude);
}
