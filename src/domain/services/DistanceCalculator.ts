import { Coordinates } from '../models/Coordinates.js';

export class DistanceCalculator {
  // Mean volumetric Earth radius in kilometers (IUGG standard)
  public static readonly EARTH_RADIUS_KM = 6371.0088;

  /**
   * Calculates the great-circle distance between two geographic points
   * using the Haversine formula.
   * @param origin Starting coordinates
   * @param destination Destination coordinates
   * @returns Distance in kilometers
   */
  public static calculateDistanceKm(origin: Coordinates, destination: Coordinates): number {
    if (origin.equals(destination)) {
      return 0;
    }

    const lat1Rad = this.toRadians(origin.latitude);
    const lon1Rad = this.toRadians(origin.longitude);
    const lat2Rad = this.toRadians(destination.latitude);
    const lon2Rad = this.toRadians(destination.longitude);

    const deltaLat = lat2Rad - lat1Rad;
    const deltaLon = lon2Rad - lon1Rad;

    const sinHalfDeltaLat = Math.sin(deltaLat / 2);
    const sinHalfDeltaLon = Math.sin(deltaLon / 2);

    const a =
      sinHalfDeltaLat * sinHalfDeltaLat +
      Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinHalfDeltaLon * sinHalfDeltaLon;

    // Numerical clamp to prevent NaN from tiny floating point overshoots
    const clampedA = Math.min(Math.max(a, 0), 1);
    const c = 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));

    return this.EARTH_RADIUS_KM * c;
  }

  private static toRadians(degrees: number): number {
    return (degrees * Math.PI) / 180;
  }
}
