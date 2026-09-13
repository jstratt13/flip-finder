// Facebook gives a city name and never coordinates, so distance for FB
// listings is estimated from a city centroid. That's approximate by nature —
// a listing can sit several miles from the centre — but Facebook deliberately
// fuzzes locations anyway ("Location is approximate"), so a centroid is about
// as precise as the underlying data ever gets.
//
// At $0.35/mile round trip a 2-mile centroid error is worth $1.40, which is
// immaterial next to the profit thresholds. Distances derived this way are
// tagged 'city' so they can be shown as approximate.

const C = {
  // Orange County
  'aliso viejo': [33.5767, -117.7256],
  anaheim: [33.8366, -117.9143],
  brea: [33.9167, -117.9],
  'buena park': [33.8675, -117.9981],
  'costa mesa': [33.6411, -117.9187],
  cypress: [33.8169, -118.0372],
  'dana point': [33.467, -117.6981],
  'fountain valley': [33.7092, -117.9537],
  fullerton: [33.8704, -117.9243],
  'garden grove': [33.7739, -117.9414],
  'huntington beach': [33.6603, -117.9992],
  irvine: [33.6846, -117.8265],
  'la habra': [33.9319, -117.9462],
  'la palma': [33.8464, -118.0467],
  'laguna beach': [33.5427, -117.7854],
  'laguna hills': [33.5963, -117.6989],
  'laguna niguel': [33.5225, -117.7075],
  'laguna woods': [33.6103, -117.725],
  'lake forest': [33.6469, -117.6892],
  'los alamitos': [33.8031, -118.0722],
  'mission viejo': [33.6, -117.672],
  'newport beach': [33.6189, -117.9298],
  orange: [33.7879, -117.8531],
  placentia: [33.8722, -117.8703],
  'rancho santa margarita': [33.6406, -117.6031],
  'san clemente': [33.427, -117.612],
  'san juan capistrano': [33.5017, -117.6625],
  'santa ana': [33.7455, -117.8677],
  'seal beach': [33.7414, -118.1048],
  stanton: [33.8025, -117.9931],
  tustin: [33.7458, -117.8261],
  'villa park': [33.8145, -117.8134],
  westminster: [33.7514, -117.994],
  'yorba linda': [33.8886, -117.8131],
  'midway city': [33.7447, -117.9884],
  'trabuco canyon': [33.6689, -117.5903],
  'ladera ranch': [33.5486, -117.6353],
  'coto de caza': [33.6006, -117.5836],
  'silverado': [33.7472, -117.6386],

  // Long Beach / South Bay / Harbor
  'long beach': [33.7701, -118.1937],
  lakewood: [33.8536, -118.1339],
  'signal hill': [33.8036, -118.1673],
  carson: [33.8317, -118.282],
  torrance: [33.8358, -118.3406],
  gardena: [33.8883, -118.309],
  lomita: [33.7922, -118.3151],
  'san pedro': [33.7361, -118.2922],
  wilmington: [33.7903, -118.2615],
  'harbor city': [33.7961, -118.2987],
  'redondo beach': [33.8492, -118.3884],
  'hermosa beach': [33.8622, -118.3995],
  'manhattan beach': [33.8847, -118.4109],
  'el segundo': [33.9192, -118.4165],
  lawndale: [33.8872, -118.3526],
  hawthorne: [33.9164, -118.3526],
  inglewood: [33.9617, -118.3531],
  'rancho palos verdes': [33.7445, -118.387],
  'palos verdes estates': [33.8006, -118.3959],
  'rolling hills estates': [33.7875, -118.3581],

  // Southeast LA County
  cerritos: [33.8583, -118.0648],
  artesia: [33.8658, -118.0831],
  'hawaiian gardens': [33.8311, -118.0728],
  bellflower: [33.8817, -118.117],
  paramount: [33.8894, -118.1598],
  downey: [33.9401, -118.1332],
  norwalk: [33.9022, -118.0817],
  'la mirada': [33.9172, -118.012],
  whittier: [33.9792, -118.0328],
  'santa fe springs': [33.9472, -118.0853],
  'pico rivera': [33.9831, -118.0967],
  montebello: [34.0165, -118.1137],
  commerce: [33.9961, -118.1598],
  'south gate': [33.9547, -118.212],
  lynwood: [33.9306, -118.2115],
  compton: [33.8958, -118.2201],
  bell: [33.9775, -118.187],
  'bell gardens': [33.9653, -118.1514],
  cudahy: [33.9658, -118.1842],
  maywood: [33.9867, -118.1853],
  'huntington park': [33.9817, -118.2251],
  vernon: [34.0039, -118.2301],

  // Central / West LA
  'los angeles': [34.0522, -118.2437],
  'santa monica': [34.0195, -118.4912],
  'culver city': [34.0211, -118.3965],
  'marina del rey': [33.9802, -118.4517],
  'playa del rey': [33.9539, -118.4453],
  'west hollywood': [34.09, -118.3617],
  'beverly hills': [34.0736, -118.4004],
  glendale: [34.1425, -118.2551],
  burbank: [34.1808, -118.309],
  pasadena: [34.1478, -118.1445],
  'south pasadena': [34.1161, -118.1503],
  'san marino': [34.1214, -118.1064],
  alhambra: [34.0953, -118.127],
  'monterey park': [34.0625, -118.1228],
  'san gabriel': [34.0961, -118.1058],
  rosemead: [34.0806, -118.0728],
  'el monte': [34.0686, -118.0276],
  'south el monte': [34.0519, -118.0467],
  'temple city': [34.1072, -118.0578],
  arcadia: [34.1397, -118.0353],
  monrovia: [34.1442, -118.0019],
  duarte: [34.1394, -117.9773],
  'sierra madre': [34.1614, -118.0528],
  altadena: [34.1897, -118.1312],

  // San Gabriel Valley / Pomona Valley
  'baldwin park': [34.0854, -117.9609],
  azusa: [34.1336, -117.9076],
  glendora: [34.1361, -117.8653],
  covina: [34.09, -117.8903],
  'west covina': [34.0686, -117.939],
  'hacienda heights': [33.9931, -117.9689],
  'rowland heights': [33.976, -117.8903],
  walnut: [34.0203, -117.8653],
  'diamond bar': [34.0286, -117.8103],
  'san dimas': [34.1067, -117.8067],
  'la verne': [34.1008, -117.7678],
  claremont: [34.0967, -117.7198],
  pomona: [34.0551, -117.7499],
  'la puente': [34.02, -117.9495],
  industry: [34.0195, -117.9581],

  // Inland Empire
  chino: [34.0122, -117.6889],
  'chino hills': [33.9898, -117.7326],
  ontario: [34.0633, -117.6509],
  upland: [34.0975, -117.6484],
  'rancho cucamonga': [34.1064, -117.5931],
  fontana: [34.0922, -117.435],
  'san bernardino': [34.1083, -117.2898],
  riverside: [33.9533, -117.3962],
  corona: [33.8753, -117.5664],
  norco: [33.9311, -117.5487],
  eastvale: [33.9525, -117.5848],
  'jurupa valley': [33.9971, -117.4854],
  'moreno valley': [33.9425, -117.2297],
  perris: [33.7825, -117.2286],
  'lake elsinore': [33.6681, -117.3273],
  wildomar: [33.599, -117.28],
  menifee: [33.6971, -117.185],
  murrieta: [33.5539, -117.2139],
  temecula: [33.4936, -117.1484],
  hemet: [33.7475, -116.9719],
  'yucaipa': [34.0336, -117.0431],
  redlands: [34.0556, -117.1825],

  // North San Diego County
  oceanside: [33.1959, -117.3795],
  carlsbad: [33.1581, -117.3506],
  vista: [33.2, -117.2425],
  'san marcos': [33.1434, -117.1661],
  escondido: [33.1192, -117.0864],
  encinitas: [33.037, -117.2920],
  fallbrook: [33.3764, -117.2511],
  'san diego': [32.7157, -117.1611],
};

const STATE_WORDS = /,?\s*(ca|california)\s*$/i;

export function coordsForCity(locationName) {
  if (!locationName) return null;

  const key = String(locationName)
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/·.*$/, '')
    .replace(STATE_WORDS, '')
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const hit = C[key];
  return hit ? { lat: hit[0], lon: hit[1] } : null;
}

export const CITY_COUNT = Object.keys(C).length;
