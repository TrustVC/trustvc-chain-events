import {
  DataTypes,
  Model,
  type Sequelize,
  type InferAttributes,
  type InferCreationAttributes,
  type CreationOptional,
} from 'sequelize';

export class Escrow extends Model<InferAttributes<Escrow>, InferCreationAttributes<Escrow>> {
  declare id: CreationOptional<number>;
  declare chainKey: string;
  declare address: string;
  declare registryAddress: string;
  declare tokenId: string;
  declare discoveredBlock: number;
  declare shredded: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
}

export function initEscrow(seq: Sequelize): void {
  Escrow.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      chainKey: { type: DataTypes.STRING(64), allowNull: false },
      address: { type: DataTypes.STRING(42), allowNull: false },
      registryAddress: { type: DataTypes.STRING(42), allowNull: false },
      tokenId: { type: DataTypes.STRING(78), allowNull: false },
      discoveredBlock: { type: DataTypes.INTEGER, allowNull: false },
      shredded: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: DataTypes.DATE,
    },
    {
      sequelize: seq,
      tableName: 'escrows',
      underscored: true,
      timestamps: true,
      updatedAt: false,
      indexes: [{ unique: true, fields: ['address', 'chain_key'] }],
    },
  );
}
