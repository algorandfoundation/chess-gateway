import { Test, TestingModule } from '@nestjs/testing';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';
import { NotFoundException } from '@nestjs/common';

describe('VerificationController', () => {
  let controller: VerificationController;
  let service: VerificationService;

  const mockVerificationService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VerificationController],
      providers: [
        {
          provide: VerificationService,
          useValue: mockVerificationService,
        },
      ],
    }).compile();

    controller = module.get<VerificationController>(VerificationController);
    service = module.get<VerificationService>(VerificationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findAll', () => {
    it('should return all verifications', async () => {
      const verifications = [{ id: 'v1' }];
      mockVerificationService.findAll.mockResolvedValue(verifications);
      const result = await controller.findAll();
      expect(result).toEqual(verifications);
      expect(service.findAll).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should return a verification by id', async () => {
      const verification = { id: 'v1' };
      mockVerificationService.findOne.mockResolvedValue(verification);
      const result = await controller.findOne('v1');
      expect(result).toEqual(verification);
      expect(service.findOne).toHaveBeenCalledWith('v1');
    });

    it('should throw NotFoundException if not found', async () => {
      mockVerificationService.findOne.mockRejectedValue(new NotFoundException());
      await expect(controller.findOne('999')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('should create a new verification', async () => {
      const dto = { userId: 'u1', id: 'p1' };
      const created = { ...dto };
      mockVerificationService.create.mockResolvedValue(created);
      const result = await controller.create(dto);
      expect(result).toEqual(created);
      expect(service.create).toHaveBeenCalledWith(dto);
    });
  });

  describe('update', () => {
    it('should update an existing verification', async () => {
      const dto = { userId: 'u1-new' };
      const updated = { id: 'p1', ...dto };
      mockVerificationService.update.mockResolvedValue(updated);
      const result = await controller.update('p1', dto);
      expect(result).toEqual(updated);
      expect(service.update).toHaveBeenCalledWith('p1', dto);
    });
  });

  describe('remove', () => {
    it('should delete a verification', async () => {
      mockVerificationService.remove.mockResolvedValue(undefined);
      await controller.remove('p1');
      expect(service.remove).toHaveBeenCalledWith('p1');
    });
  });
});
