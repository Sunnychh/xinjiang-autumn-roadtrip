import { photoFeatures } from './model.mjs';

export async function createMemoryMap({ container, status, onSelect }) {
  const [styleResponse, planResponse] = await Promise.all([fetch('./map-style.json'), fetch('./plan.json')]);
  if (!styleResponse.ok || !planResponse.ok) throw new Error('地图资源未加载');
  const [style, plan] = await Promise.all([styleResponse.json(), planResponse.json()]);
  const lib = globalThis.maplibregl;
  if (!lib) throw new Error('地图组件未加载');
  let ready = false, pending = [], hasTiles = false;
  const map = new lib.Map({ container, style, center: [83.8, 43.5], zoom: 6,
    minZoom: 1, maxZoom: 19, attributionControl: false, locale: { 'NavigationControl.ZoomIn': '放大', 'NavigationControl.ZoomOut': '缩小', 'AttributionControl.ToggleAttribution': '地图来源' }, localFontFamily: 'PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif',
    localIdeographFontFamily: 'PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif', refreshExpiredTiles: false });
  map.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new lib.AttributionControl({ compact: true, customAttribution: style.metadata?.attribution || '' }));
  const boundsFor = coordinates => {
    const bounds = new lib.LngLatBounds();
    coordinates.forEach(point => bounds.extend(point));
    return bounds;
  };
  const planCoordinates = plan.features.flatMap(feature => feature.geometry.coordinates);
  const fitPlan = () => map.fitBounds(boundsFor(planCoordinates), { padding: 38, duration: 0, maxZoom: 9 });
  const fitPhotos = () => { if (pending.length) map.fitBounds(boundsFor(pending.map(group => [group.location.lng, group.location.lat])), { padding: 55, duration: 0, maxZoom: 13 }); };
  map.on('sourcedata', event => {
    if (event.sourceId === 'versatiles-shortbread' && event.tile?.state === 'loaded') {
      hasTiles = true; status('中文地图已加载。点击橙色照片点查看风景。');
    }
  });
  map.on('error', () => { if (!hasTiles) status('在线底图暂未加载完整，请检查网络；照片列表仍可查看。', 'error'); });
  map.on('load', () => {
    map.addSource('plan', { type: 'geojson', data: plan });
    map.addLayer({ id: 'plan-line', type: 'line', source: 'plan', layout: { 'line-join': 'round' }, paint: { 'line-color': '#638e7b', 'line-width': 3, 'line-opacity': 0.8, 'line-dasharray': [3, 2] } });
    map.addSource('photos', { type: 'geojson', data: photoFeatures(pending) });
    map.addLayer({ id: 'photo-points', type: 'circle', source: 'photos', paint: { 'circle-radius': ['case', ['>', ['get', 'count'], 1], 15, 10], 'circle-color': '#ce6635', 'circle-stroke-width': 3, 'circle-stroke-color': '#fffefa' } });
    map.addLayer({ id: 'photo-counts', type: 'symbol', source: 'photos', filter: ['>', ['get', 'count'], 1], layout: { 'text-field': ['get', 'label'], 'text-font': ['sans-serif'], 'text-size': 11, 'text-allow-overlap': true }, paint: { 'text-color': '#fffefa' } });
    map.on('click', 'photo-points', event => { const id = event.features?.[0]?.properties?.group; if (id) onSelect(id); });
    map.on('mouseenter', 'photo-points', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'photo-points', () => { map.getCanvas().style.cursor = ''; });
    ready = true;
    if (!hasTiles) status('正在加载道路与中文地名…');
  });
  fitPlan();
  const timeout = setTimeout(() => { if (!hasTiles) status('在线底图加载较慢，请检查网络；照片列表仍可查看。', 'error'); }, 20000);
  return {
    setGroups(groups) { pending = groups; if (ready) map.getSource('photos').setData(photoFeatures(groups)); },
    fitPlan, fitPhotos,
    focus(location) { if (location) map.easeTo({ center: [location.lng, location.lat], zoom: Math.max(map.getZoom(), 10), duration: 0 }); },
    destroy() { clearTimeout(timeout); map.remove(); },
  };
}
