import { describe, it, expect } from 'vitest';
import { Coordinates } from '../../src/domain/models/Coordinates.js';
import { DistanceCalculator } from '../../src/domain/services/DistanceCalculator.js';

describe('DistanceCalculator', () => {
  it('should return 0 km when origin and destination are identical', () => {
    const ny = Coordinates.create(40.639722, -73.778889);
    const distance = DistanceCalculator.calculateDistanceKm(ny, ny);
    expect(distance).toBe(0);
  });

  it('should accurately calculate distance between New York and Los Angeles (~3,974 km)', () => {
    // JFK: 40.639722, -73.778889
    // LAX: 33.9425, -118.408056
    const ny = Coordinates.create(40.639722, -73.778889);
    const la = Coordinates.create(33.9425, -118.408056);

    const distance = DistanceCalculator.calculateDistanceKm(ny, la);
    // Great circle distance JFK to LAX is ~3,974 km
    expect(distance).toBeGreaterThan(3950);
    expect(distance).toBeLessThan(4000);
  });

  it('should accurately calculate distance between Paris and Warsaw (~1,368 km)', () => {
    const paris = Coordinates.create(49.009722, 2.547778);
    const warsaw = Coordinates.create(52.165833, 20.967222);

    const distance = DistanceCalculator.calculateDistanceKm(paris, warsaw);
    expect(distance).toBeGreaterThan(1340);
    expect(distance).toBeLessThan(1400);
  });

  it('should be symmetric: distance(A, B) === distance(B, A)', () => {
    const hk = Coordinates.create(22.308889, 113.914444);
    const sp = Coordinates.create(-23.435556, -46.473056);

    const distA = DistanceCalculator.calculateDistanceKm(hk, sp);
    const distB = DistanceCalculator.calculateDistanceKm(sp, hk);

    expect(Math.abs(distA - distB)).toBeLessThan(1e-6);
  });
});
