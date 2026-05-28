import { DataTypes, Model, type Sequelize, type InferAttributes, type InferCreationAttributes } from 'sequelize';

export class ChainLease extends Model<InferAttributes<ChainLease>, InferCreationAttributes<ChainLease>> {
  declare chainKey: string;
  declare holderId: string;
  declare acquiredAt: Date;
  declare expiresAt: Date;
  declare renewedAt: Date;
}

export function initChainLease(seq: Sequelize): void {
  ChainLease.init(
    {
      chainKey: { type: DataTypes.STRING(64), primaryKey: true },
      holderId: { type: DataTypes.STRING(128), allowNull: false },
      acquiredAt: { type: DataTypes.DATE, allowNull: false },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      renewedAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize: seq, tableName: 'chain_leases', underscored: true, timestamps: false },
  );
}
