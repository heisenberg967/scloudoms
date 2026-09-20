import { IWarehouseRepository } from '../../domain/repositories/IWarehouseRepository.js';
import { WarehouseResponseDTO } from '../dtos/OrderDTOs.js';

export class ListWarehousesUseCase {
  constructor(private readonly warehouseRepo: IWarehouseRepository) {}

  public async execute(): Promise<WarehouseResponseDTO[]> {
    const warehouses = await this.warehouseRepo.findAll();
    return warehouses.map((w) => ({
      id: w.id,
      name: w.name,
      coordinates: {
        latitude: w.coordinates.latitude,
        longitude: w.coordinates.longitude
      },
      stock: w.stock,
      updatedAt: w.updatedAt.toISOString()
    }));
  }
}
