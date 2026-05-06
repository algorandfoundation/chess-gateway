import { Test, TestingModule } from '@nestjs/testing';
import { VerificationService } from './verification.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LinkVerification } from './entities/link-verification.entity';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';

describe('VerificationService', () => {
  let service: VerificationService;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let repository: Repository<LinkVerification>;

  const mockRepository = {
    find: jest.fn(),
    findOneBy: jest.fn(),
    findBy: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerificationService,
        {
          provide: getRepositoryToken(LinkVerification),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<VerificationService>(VerificationService);
    repository = module.get<Repository<LinkVerification>>(getRepositoryToken(LinkVerification));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('should return an array of verifications', async () => {
      const expected = [{ id: '1' }];
      mockRepository.find.mockResolvedValue(expected);
      const result = await service.findAll();
      expect(result).toEqual(expected);
    });
  });

  describe('findOne', () => {
    it('should return a verification if found', async () => {
      const expected = { id: '1' };
      mockRepository.findOneBy.mockResolvedValue(expected);
      const result = await service.findOne('1');
      expect(result).toEqual(expected);
    });

    it('should throw NotFoundException if not found', async () => {
      mockRepository.findOneBy.mockResolvedValue(null);
      await expect(service.findOne('1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByUserId', () => {
    it('should find by userId', async () => {
      const expected = { userId: 'u1' };
      mockRepository.findOneBy.mockResolvedValue(expected);
      const result = await service.findByUserId('u1');
      expect(result).toEqual(expected);
      expect(mockRepository.findOneBy).toHaveBeenCalledWith({ userId: 'u1' });
    });
  });

  describe('findByPlayerId', () => {
    it('should find by player id', async () => {
      const expected = [{ id: 'p1' }];
      mockRepository.findBy.mockResolvedValue(expected);
      const result = await service.findByPlayerId('p1');
      expect(result).toEqual(expected);
      expect(mockRepository.findBy).toHaveBeenCalledWith({ id: 'p1' });
    });
  });

  describe('create', () => {
    it('should create and save', async () => {
      const data = { userId: 'u1', id: 'p1' };
      mockRepository.create.mockReturnValue(data);
      mockRepository.save.mockResolvedValue(data);
      const result = await service.create(data);
      expect(result).toEqual(data);
    });
  });

  describe('update', () => {
    it('should update and save', async () => {
      const existing = { id: 'p1', userId: 'u1' };
      const updateData = { walletAddress: '0x123' };
      mockRepository.findOneBy.mockResolvedValue(existing);
      mockRepository.save.mockResolvedValue({ ...existing, ...updateData });
      const result = await service.update('p1', updateData);
      expect(result.walletAddress).toBe('0x123');
    });
  });

  describe('remove', () => {
    it('should delete and not throw if affected > 0', async () => {
      mockRepository.delete.mockResolvedValue({ affected: 1 });
      await service.remove('p1');
      expect(mockRepository.delete).toHaveBeenCalledWith('p1');
    });

    it('should throw NotFoundException if affected === 0', async () => {
      mockRepository.delete.mockResolvedValue({ affected: 0 });
      await expect(service.remove('p1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('upsert', () => {
    it('should update existing if found by userId', async () => {
      const existing = { userId: 'u1', id: 'p1', associatedAt: new Date() };
      mockRepository.findOneBy.mockResolvedValue(existing);
      mockRepository.save.mockImplementation((val) => Promise.resolve(val));

      const result = await service.upsert('u1', 'p2', true, '0xNew');

      expect(result.id).toBe('p2');
      expect(result.walletAddress).toBe('0xNew');
      expect(mockRepository.save).toHaveBeenCalledWith(existing);
    });

    it('should create new if not found', async () => {
      mockRepository.findOneBy.mockResolvedValue(null);
      mockRepository.create.mockImplementation((val) => val);
      mockRepository.save.mockImplementation((val) => Promise.resolve(val));

      const result = await service.upsert('u1', 'p1', true, '0xWallet');

      expect(result.userId).toBe('u1');
      expect(result.id).toBe('p1');
      expect(result.walletAddress).toBe('0xWallet');
      expect(mockRepository.create).toHaveBeenCalled();
    });
  });
});
