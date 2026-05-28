import {
  DataTypes,
  Model,
  type Sequelize,
  type InferAttributes,
  type InferCreationAttributes,
  type CreationOptional,
} from 'sequelize';

export class RegistryAddress extends Model<InferAttributes<RegistryAddress>, InferCreationAttributes<RegistryAddress>> {
  declare id: CreationOptional<number>;
  declare chainKey: string;
  declare address: string;
  declare fromBlock: number;
  declare active: CreationOptional<boolean>;
  declare addedAt: CreationOptional<Date>;
}

export function initRegistryAddress(seq: Sequelize): void {
  RegistryAddress.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      chainKey: { type: DataTypes.STRING(64), allowNull: false },
      address: { type: DataTypes.STRING(42), allowNull: false },
      fromBlock: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      addedAt: DataTypes.DATE,
    },
    {
      sequelize: seq,
      tableName: 'registry_addresses',
      underscored: true,
      timestamps: true,
      createdAt: 'added_at',
      updatedAt: false,
      indexes: [{ unique: true, fields: ['chain_key', 'address'] }],
    },
  );
}
