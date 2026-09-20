export class Coordinates {
  readonly latitude: number;
  readonly longitude: number;

  private constructor(latitude: number, longitude: number) {
    this.latitude = latitude;
    this.longitude = longitude;
  }

  public static create(latitude: number, longitude: number): Coordinates {
    if (typeof latitude !== 'number' || isNaN(latitude)) {
      throw new Error(`Invalid latitude: must be a valid number, received ${latitude}`);
    }
    if (typeof longitude !== 'number' || isNaN(longitude)) {
      throw new Error(`Invalid longitude: must be a valid number, received ${longitude}`);
    }
    if (latitude < -90 || latitude > 90) {
      throw new Error(
        `Latitude out of bounds: must be between -90 and 90 degrees, received ${latitude}`
      );
    }
    if (longitude < -180 || longitude > 180) {
      throw new Error(
        `Longitude out of bounds: must be between -180 and 180 degrees, received ${longitude}`
      );
    }

    return new Coordinates(latitude, longitude);
  }

  public equals(other: Coordinates): boolean {
    return this.latitude === other.latitude && this.longitude === other.longitude;
  }

  public toJSON() {
    return {
      latitude: this.latitude,
      longitude: this.longitude
    };
  }
}
