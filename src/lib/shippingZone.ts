// Rough label cost to one buyer, for answering Best Offers. eBay only tells
// us the buyer's 3-digit ZIP, which is all a USPS zone needs.
//
// Zones are USPS's chart for origin ZIP 606xx (EBAY_LISTING_ZIP is 60620),
// effective Oct 1, 2026, from postcalc.usps.com. Rates are USPS Ground
// Advantage Commercial (Notice 123, effective Oct 4, 2026). eBay's labels
// cost less than Commercial, so the rate is scaled to Cristian's real
// average label: his median sold item weighs just under 1 lb (measured
// 2026-10-14), so typicalSingleLabelCost() is treated as the under-1-lb
// rate to a middle zone (5), and every other weight/zone moves in step.

// One character per ZIP3 (index = the ZIP3 as a number), "0" = not a
// mailable destination from here.
const ZONE_BY_ZIP3 =
  "0000058888555555555555555555555555555555555555665555555555555555555555555555555555555555555555555555555555555555555555555555555555444555555544444444444444444444444444444444444554445555554545555555555544444455445450545455444454444445555555544444444444444444444444444444404445455555454555444455545545554454545455545555555555555555566666655666666050560644405444445545555555444444444444444444445555555454333444344434444444404443444400333333344444444444333333334433233112222233333333323333333333223222334443444433444444444000333333333022202202334333343343440444444344444445004444555500445555555066556666661111111112222232222330333333343303334444440044444444444444404440444444554445555544044444445555000000550555555055555055554444444444550555555544044555545555555555555555555650555555566666665565555555566655555555555666666000565566555666666777706666666600777706770660077600006606666566666666000777077707707777777770777777777777777777707877877778887888888888778887778788888089787788777777787770777777788888";

// Index 0 is "under 1 lb"; index n is "not over n lb". Columns are zones 1-8.
const GROUND_ADVANTAGE_COMMERCIAL: number[][] = [
  [7.33, 7.34, 7.70, 7.86, 8.24, 8.41, 8.62, 8.95],
  [8.01, 8.08, 8.40, 8.55, 9.29, 10.18, 10.53, 11.22],
  [8.39, 8.48, 8.66, 8.91, 10.50, 12.13, 12.55, 13.42],
  [9.04, 9.06, 9.54, 10.07, 12.12, 14.14, 14.91, 16.30],
  [9.93, 9.99, 10.35, 11.30, 13.89, 16.21, 17.24, 19.06],
  [10.35, 10.41, 10.79, 11.67, 14.53, 16.94, 18.17, 20.24],
  [10.52, 10.59, 11.01, 12.20, 15.33, 17.94, 19.36, 21.73],
  [10.61, 10.67, 11.27, 12.55, 15.95, 18.70, 20.28, 22.88],
  [10.75, 10.92, 12.14, 13.08, 16.54, 19.39, 21.13, 23.95],
  [11.66, 11.90, 13.04, 14.30, 17.16, 20.18, 22.06, 25.14],
  [12.56, 12.91, 13.83, 15.09, 17.81, 20.99, 23.02, 26.39],
  [13.80, 13.99, 15.05, 16.23, 19.87, 23.03, 25.43, 29.12],
  [14.54, 14.90, 15.68, 16.94, 20.61, 23.95, 26.53, 30.48],
  [15.20, 15.53, 16.30, 17.58, 21.37, 24.91, 27.62, 31.86],
  [15.78, 16.12, 16.86, 18.18, 22.13, 25.89, 28.74, 33.28],
  [16.28, 16.58, 17.36, 18.72, 22.90, 26.88, 29.86, 34.66],
  [16.69, 16.96, 17.78, 18.99, 23.64, 27.84, 30.97, 36.04],
  [17.02, 17.34, 18.20, 19.46, 24.26, 28.60, 31.86, 37.17],
  [17.26, 17.51, 18.66, 19.99, 24.91, 29.45, 32.84, 38.39],
  [17.43, 17.87, 18.86, 20.41, 25.54, 30.27, 33.82, 39.59],
  [17.51, 18.11, 19.08, 20.71, 26.68, 32.07, 36.42, 42.14],
  [19.53, 20.59, 21.71, 22.84, 27.88, 33.44, 39.71, 44.76],
  [20.91, 22.27, 23.64, 25.12, 31.20, 38.48, 46.08, 51.49],
  [22.56, 24.21, 25.97, 28.38, 35.80, 45.04, 53.89, 60.16],
  [24.49, 26.32, 28.69, 32.67, 41.69, 53.03, 63.15, 70.72],
  [26.37, 28.59, 31.77, 37.65, 48.69, 59.99, 70.61, 79.94],
  [29.42, 31.83, 35.41, 42.22, 58.16, 69.43, 80.31, 90.50],
  [30.36, 32.99, 36.96, 44.73, 61.66, 72.94, 84.05, 95.16],
  [31.12, 33.85, 38.00, 46.00, 63.45, 75.19, 86.72, 98.23],
  [31.87, 34.70, 39.02, 47.26, 65.23, 77.39, 89.35, 101.28],
  [32.61, 35.53, 40.01, 48.49, 66.98, 79.58, 91.94, 104.30],
];

const CALIBRATION_ZONE = 5;

export function zoneForZip3(zip3: string | null): number | null {
  if (!zip3 || !/^\d{3}$/.test(zip3)) return null;
  const zone = Number(ZONE_BY_ZIP3[Number(zip3)]);
  return zone > 0 ? Math.min(zone, 8) : null;
}

function commercialRate(weightLbs: number, zone: number): number {
  const tier = weightLbs < 1 ? 0 : Math.min(Math.ceil(weightLbs), GROUND_ADVANTAGE_COMMERCIAL.length - 1);
  return GROUND_ADVANTAGE_COMMERCIAL[tier][zone - 1];
}

// weightLbs null = no weight on the item; it's then priced as a typical
// (under 1 lb) parcel. Returns the typical label unchanged when the zone is
// unknown (no ZIP, or outside the US).
export function estimateLabelCost(input: { typicalLabel: number; weightLbs: number | null; zone: number | null }): number {
  if (input.zone == null) return input.typicalLabel;
  const scale = input.typicalLabel / GROUND_ADVANTAGE_COMMERCIAL[0][CALIBRATION_ZONE - 1];
  const estimate = commercialRate(input.weightLbs ?? 0, input.zone) * scale;
  return Math.round(estimate * 100) / 100;
}
