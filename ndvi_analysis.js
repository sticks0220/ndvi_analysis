/**
 * Multisensor NDVI / NDMI composites for Google Earth Engine (JavaScript).
 * Version: 0.2.0
 *
 * Input: an Earth Engine FeatureCollection containing named region polygons.
 * Output: GeoTIFF export tasks (Drive), with chosen bands scaled x10000 to Int16.
 *
 * Satellite priority when valid pixels overlap:
 * Landsat 5 -> Landsat 7 -> Landsat 8 -> Landsat 9 -> Sentinel-2.
 * Main period takes priority over the wider fallback period.
 *
 * No external require() dependency. Designed for the GEE Code Editor.
 * NOTE: Update collection_path and feature-name settings before running.
 */

// ============================================================================
// 1. USER SETTINGS
// ============================================================================


var year = 2026;
var months = [8];                // e.g. [5, 6, 7], ['summer'], ['winter']
var mosaic_type = 'median';      // 'median', 'min', 'quality', 'overlap'

var region_name = 'Белгородская область';
var collection_path = 'FAO/GAUL/2015/level1';
var name_attr = 'ADM1_NAME';
var region_query = 'Belgorod';

var zoom = 7;                   // 0 = do not change map zoom
var view_layers = true;
var use_secondary_period = true;
var max_cloud_cover = 100;      // scene-level threshold, 0..100 (%)

// Bands exported as one GeoTIFF. To export only NDVI: ['ndvi'].
// Available: red, green, blue, nir, swir, ndvi, ndmi.
var save_bands = ['red', 'green', 'blue', 'ndvi', 'ndmi'];

// All exported bands are multiplied by 10000 and converted to signed Int16.
// For NDVI/NDMI, divide exported pixel values by 10000 after loading the TIFF.
var export_scale = (year >= 2015) ? 10 : 30;
var export_crs = 'EPSG:3857';   // can be changed to an appropriate projected CRS
var export_folder = region_name;

// ============================================================================
// 2. CONSTANTS AND SATELLITE CATALOG
// ============================================================================
var OPTICAL_BANDS = ['red', 'green', 'blue', 'nir', 'swir'];
var RESULT_BANDS = ['red', 'green', 'blue', 'nir', 'swir', 'ndvi', 'ndmi'];
var EMPTY = ee.Image.constant([0, 0, 0, 0, 0, 0, 0])
  .rename(RESULT_BANDS)
  .toFloat()
  .updateMask(ee.Image.constant(0))
  .set('cloudiness', 999);

var ndvi_vis = {
  min: -0.2, max: 0.85,
  palette: ['a50026', 'd73027', 'f46d43', 'fdae61', 'fee08b', 'ffffbf', 'c2e699', '78c679', '238b45', '006837']
};
var ndmi_vis = {
  min: -0.6, max: 0.6,
  palette: ['a6611a', 'dfc27d', 'f5f5f5', '80cdc1', '018571']
};
var rgb_vis = {bands: ['red', 'green', 'blue'], min: 0.02, max: 0.3, gamma: 1.2};

// start inclusive, end exclusive; date limits prevent querying satellites
// outside their actual operation windows. L2 Sentinel-2 is used from 2019
// because its coverage in 2017-2018 is not globally complete.
var SATELLITES = [
  {
    id: 'l5', kind: 'landsat',
    collection: 'LANDSAT/LT05/C02/T1_L2',
    bands: ['SR_B3', 'SR_B2', 'SR_B1', 'SR_B4', 'SR_B5'],
    cloudProperty: 'CLOUD_COVER',
    start: '1984-03-16', end: '2012-05-06'
  },
  {
    id: 'l7', kind: 'landsat',
    collection: 'LANDSAT/LE07/C02/T1_L2',
    bands: ['SR_B3', 'SR_B2', 'SR_B1', 'SR_B4', 'SR_B5'],
    cloudProperty: 'CLOUD_COVER',
    start: '1999-05-28', end: '2024-01-20'
  },
  {
    id: 'l8', kind: 'landsat',
    collection: 'LANDSAT/LC08/C02/T1_L2',
    bands: ['SR_B4', 'SR_B3', 'SR_B2', 'SR_B5', 'SR_B6'],
    cloudProperty: 'CLOUD_COVER',
    start: '2013-03-18', end: '9999-12-31'
  },
  {
    id: 'l9', kind: 'landsat',
    collection: 'LANDSAT/LC09/C02/T1_L2',
    bands: ['SR_B4', 'SR_B3', 'SR_B2', 'SR_B5', 'SR_B6'],
    cloudProperty: 'CLOUD_COVER',
    start: '2021-10-31', end: '9999-12-31'
  },
  {
    id: 's2_toa', kind: 'sentinel_toa',
    collection: 'COPERNICUS/S2_HARMONIZED',
    bands: ['B4', 'B3', 'B2', 'B8', 'B11'],
    cloudProperty: 'CLOUDY_PIXEL_PERCENTAGE',
    start: '2015-06-27', end: '2019-01-01'
  },
  {
    id: 's2_sr', kind: 'sentinel_sr',
    collection: 'COPERNICUS/S2_SR_HARMONIZED',
    bands: ['B4', 'B3', 'B2', 'B8', 'B11'],
    cloudProperty: 'CLOUDY_PIXEL_PERCENTAGE',
    start: '2019-01-01', end: '9999-12-31'
  }
];

// ============================================================================
// 3. DATE HELPERS — correct year boundaries for January, December and winter
// ============================================================================
function pad(number) {
  return ('0' + number).slice(-2);
}

function utcDate(y, m, d) {
  // JS month is 0-based. Overflow/underflow automatically changes the year.
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(date) {
  return date.getUTCFullYear() + '-' +
    pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
}

function makePeriod(y, value) {
  var mainStart;
  var mainEnd;
  var extraStart;
  var extraEnd;
  var label;

  if (value === 'summer') {
    // Growing season: May 1 to October 1 (May–September inclusive).
    mainStart = utcDate(y, 5, 1);
    mainEnd = utcDate(y, 10, 1);
    extraStart = utcDate(y, 4, 15);
    extraEnd = utcDate(y, 10, 15);
    label = 'summer';
  } else if (value === 'winter') {
    // Winter of year y: December of (y-1) + January–February of y.
    mainStart = utcDate(y - 1, 12, 1);
    mainEnd = utcDate(y, 3, 1);
    extraStart = utcDate(y - 1, 11, 15);
    extraEnd = utcDate(y, 3, 15);
    label = 'winter';
  } else {
    if (typeof value !== 'number' || value < 1 || value > 12 ||
        Math.floor(value) !== value) {
      throw new Error('Period must be an integer month 1..12, summer or winter.');
    }
    mainStart = utcDate(y, value, 1);
    mainEnd = utcDate(y, value + 1, 1);
    extraStart = utcDate(y, value - 1, 15);
    extraEnd = utcDate(y, value + 1, 15);
    label = pad(value);
  }

  return {
    label: label,
    main: [formatDate(mainStart), formatDate(mainEnd)],
    secondary: [formatDate(extraStart), formatDate(extraEnd)]
  };
}

// ============================================================================
// 4. CLOUD MASKS AND INDICES
// ============================================================================
function maskLandsat(image) {
  var qa = image.select('QA_PIXEL');

  // Bits 0-5: fill, dilated cloud, cirrus (L8/9; unused on L5/7),
  // cloud, cloud shadow, snow. Water remains valid.
  var clear = qa.bitwiseAnd(63).eq(0);
  var notSaturated = image.select('QA_RADSAT').eq(0);
  return clear.and(notSaturated);
}

function maskSentinelSr(image) {
  var scl = image.select('SCL');
  // 4 vegetation, 5 bare soils, 6 water.
  // Exclude 3 cloud shadow; 7 unclassified; 8/9 clouds; 10 cirrus; 11 snow.
  return scl.eq(4).or(scl.eq(5)).or(scl.eq(6));
}

function maskSentinelToa(image) {
  var qa = image.select('QA60');
  return qa.bitwiseAnd(1 << 10).eq(0)
    .and(qa.bitwiseAnd(1 << 11).eq(0));
}

function addIndices(image) {
  // expression() does not implicitly mask negative reflectance as
  // normalizedDifference() does. Denominators close to zero are masked.
  var nir = image.select('nir');
  var red = image.select('red');
  var swir = image.select('swir');

  var ndvi = image.expression('(n - r) / (n + r)', {
    n: nir, r: red
  }).rename('ndvi').updateMask(nir.add(red).abs().gt(1e-6));

  var ndmi = image.expression('(n - s) / (n + s)', {
    n: nir, s: swir
  }).rename('ndmi').updateMask(nir.add(swir).abs().gt(1e-6));

  return image.addBands([ndvi, ndmi]).select(RESULT_BANDS);
}

function prepareImage(image, satellite) {
  var reflectance = image.select(satellite.bands, OPTICAL_BANDS);
  var clear;

  if (satellite.kind === 'landsat') {
    reflectance = reflectance.multiply(0.0000275).add(-0.2);
    clear = maskLandsat(image);
  } else {
    reflectance = reflectance.divide(10000);
    clear = (satellite.kind === 'sentinel_sr') ?
      maskSentinelSr(image) : maskSentinelToa(image);
  }

  reflectance = reflectance.toFloat().updateMask(clear);
  return addIndices(reflectance)
    .copyProperties(image, ['system:time_start'])
    .set('cloudiness', image.get(satellite.cloudProperty));
}

// ============================================================================
// 5. COLLECTIONS AND COMPOSITING
// ============================================================================
function overlapsRange(window, satellite) {
  return window[0] < satellite.end && window[1] > satellite.start;
}

function makeCollection(satellite, geometry, window) {
  var start = (window[0] > satellite.start) ? window[0] : satellite.start;
  var end = (window[1] < satellite.end) ? window[1] : satellite.end;

  return ee.ImageCollection(satellite.collection)
    .filterBounds(geometry)
    .filterDate(start, end) // end exclusive
    .filter(ee.Filter.lt(satellite.cloudProperty, max_cloud_cover))
    .map(function (image) { return prepareImage(image, satellite); });
}

function compositeCollection(collection) {
  // A fully masked template ensures composite operations remain well-defined
  // even if there are zero scenes (the .size() still counts original scenes).
  var safe = collection.merge(ee.ImageCollection([EMPTY]));

  if (mosaic_type === 'median') {
    return safe.median().select(RESULT_BANDS);
  }
  if (mosaic_type === 'min') {
    return safe.min().select(RESULT_BANDS);
  }
  if (mosaic_type === 'quality') {
    // Select the highest unclouded NDVI pixel per image.
    return safe.qualityMosaic('ndvi').select(RESULT_BANDS);
  }
  // 'overlap': least cloudy scenes last, then mosaic() prioritizes them.
  return safe.sort('cloudiness', false).mosaic().select(RESULT_BANDS);
}

function composeRegionPeriod(geometry, period) {
  var windows = use_secondary_period ? [period.secondary, period.main] :
    [period.main];
  var combined = EMPTY;
  var sceneCount = ee.Number(0);

  for (var w = 0; w < windows.length; w++) {
    var window = windows[w];

    for (var s = 0; s < SATELLITES.length; s++) {
      var satellite = SATELLITES[s];
      if (!overlapsRange(window, satellite)) continue;

      var collection = makeCollection(satellite, geometry, window);
      sceneCount = sceneCount.add(collection.size());
      var candidate = compositeCollection(collection);

      // The current scene has precedence wherever it is valid.
      // Earlier sensors / wider periods only fill gaps, never replace it.
      combined = candidate.unmask(combined, false);
    }
  }

  return {image: combined.clip(geometry), sceneCount: sceneCount};
}

// ============================================================================
// 6. VALIDATION, REGION LOOP AND EXPORT
// ============================================================================
function transliterate(text) {
  var letters = {
    'а':'a', 'б':'b', 'в':'v', 'г':'g', 'д':'d', 'е':'e', 'ё':'e',
    'ж':'zh', 'з':'z', 'и':'i', 'й':'y', 'к':'k', 'л':'l', 'м':'m',
    'н':'n', 'о':'o', 'п':'p', 'р':'r', 'с':'s', 'т':'t', 'у':'u',
    'ф':'f', 'х':'kh', 'ц':'ts', 'ч':'ch', 'ш':'sh', 'щ':'shch',
    'ъ':'', 'ы':'y', 'ь':'', 'э':'e', 'ю':'yu', 'я':'ya'
  };
  var chars = String(text).toLowerCase().split('');
  var result = '';
  for (var i = 0; i < chars.length; i++) {
    result += (letters.hasOwnProperty(chars[i])) ? letters[chars[i]] : chars[i];
  }
  return result.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'region';
}

if (['median', 'min', 'quality', 'overlap'].indexOf(mosaic_type) === -1) {
  throw new Error('Unknown mosaic_type: ' + mosaic_type);
}
if (year < 1984 || Math.floor(year) !== year) {
  throw new Error('year must be an integer >= 1984.');
}
if (!months.length || !save_bands.length) {
  throw new Error('months and save_bands must not be empty.');
}
if (max_cloud_cover <= 0 || max_cloud_cover > 100) {
  throw new Error('max_cloud_cover must be >0 and <=100.');
}
for (var b = 0; b < save_bands.length; b++) {
  if (RESULT_BANDS.indexOf(save_bands[b]) === -1) {
    throw new Error('Unknown save band: ' + save_bands[b]);
  }
}



var parts = ee.FeatureCollection(collection_path)
  .filter(ee.Filter.eq('ADM0_NAME', 'Russian Federation'))
  .filter(ee.Filter.stringContains(name_attr, region_query));

print('Найденные регионы:', parts);
print('Количество объектов:', parts.size());
print('Названия:', parts.aggregate_array(name_attr));

Map.centerObject(parts, 8);
Map.addLayer(parts, {color: 'red'}, region_name);


var partCount = parts.size().getInfo();
print('Region:', region_name, 'Number of features:', partCount);

if (partCount === 0) {
  throw new Error('No matching polygons. Check collection_path, name_attr and region_name.');
}
if (zoom > 0) Map.centerObject(parts, zoom);

var partList = parts.toList(partCount);
for (var partIndex = 0; partIndex < partCount; partIndex++) {
  var part = ee.Feature(partList.get(partIndex));
  var geometry = part.geometry();
  var sourceName = part.get(name_attr).getInfo();
  var partName = transliterate(sourceName || region_name);
  if (partCount > 1) partName += '_part_' + pad(partIndex + 1);

  for (var i = 0; i < months.length; i++) {
    var period = makePeriod(year, months[i]);
    var taskName = partName + '_' + year + '-' + period.label;

    print('Processing:', taskName,
      'main:', period.main,
      'extended:', use_secondary_period ? period.secondary : 'off');

    var result = composeRegionPeriod(geometry, period);
    var totalScenes = result.sceneCount.getInfo();

    if (!totalScenes) {
      print('SKIPPED (no available scenes):', taskName);
      continue;
    }
    print('Scene references (including overlap across windows):', totalScenes);

    // All selected bands use the same scaling: physical value * 10000.
    // Clamp to Int16 range to avoid integer overflow at anomalous pixels.
    var forExport = result.image
      .select(save_bands)
      .multiply(10000)
      .round()
      .clamp(-32768, 32767)
      .toInt16();

    var suffix = (save_bands.length === 1) ? save_bands[0] : 'multiband';
    var outputName = taskName + '_' + suffix + '_int16';

    Export.image.toDrive({
      image: forExport,
      description: outputName,
      fileNamePrefix: outputName,
      folder: export_folder,
      region: geometry,
      scale: export_scale,
      crs: export_crs,
      maxPixels: 1e13,
      fileFormat: 'GeoTIFF'
    });

    if (view_layers) {
      Map.addLayer(result.image.select('ndvi'), ndvi_vis, taskName + '_ndvi', true);
      Map.addLayer(result.image.select('ndmi'), ndmi_vis, taskName + '_ndmi', false);
      Map.addLayer(result.image.select(['red', 'green', 'blue']),
        rgb_vis, taskName + '_rgb', false);
    }
  }
}

print('Export tasks created. Start them in the Earth Engine Tasks tab.');

