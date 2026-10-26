// The garage. Multiple cars, each with the figures the power estimate needs.

import { allVehicles, putVehicle, deleteVehicle } from './storage.js';
import { DEFAULTS } from './config.js';

export function newVehicle(fields = {}) {
  return {
    id: `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    year: '',
    makeModel: '',
    massKg: null,       // kerb weight plus driver; needed for the power estimate
    cdA: DEFAULTS.DEFAULT_CDA,
    crr: DEFAULTS.DEFAULT_CRR,
    economy: null,      // mpg (imperial) or L/100km (metric), for fuel cost
    colour: '#FFB020',
    createdAt: Date.now(),
    ...fields,
  };
}

export const listVehicles = () => allVehicles();
export const saveVehicle = (v) => putVehicle(v);
export const removeVehicle = (id) => deleteVehicle(id);

export function vehicleLabel(v) {
  if (!v) return '';
  if (v.name) return v.name;
  return [v.year, v.makeModel].filter(Boolean).join(' ') || 'Unnamed car';
}

export function findVehicle(list, id) {
  return list.find((v) => v.id === id) || null;
}

/**
 * Fuel used and what it cost. Rough by nature: it assumes the car's rated
 * economy, which no car achieves exactly.
 */
export function fuelEstimate(distanceM, vehicle, { system, pricePerUnit }) {
  if (!vehicle || !vehicle.economy || !Number.isFinite(pricePerUnit)) return null;
  if (system === 'metric') {
    const litres = (distanceM / 1000) * (vehicle.economy / 100);
    return { amount: litres, unit: 'L', cost: litres * pricePerUnit };
  }
  const gallons = distanceM / 1609.344 / vehicle.economy;
  return { amount: gallons, unit: 'gal', cost: gallons * pricePerUnit };
}
