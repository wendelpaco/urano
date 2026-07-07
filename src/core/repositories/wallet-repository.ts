import type { Wallet } from '../entities/wallet.ts';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
}
