import {
  DataTypes,
  Model,
  type Sequelize,
  type InferAttributes,
  type InferCreationAttributes,
  type CreationOptional,
} from 'sequelize';

export class BlockProgress extends Model<InferAttributes<BlockProgress>, InferCreationAttributes<BlockProgress>> {
  declare chainKey: string;
  declare lastSeenBlock: number;
  declare updatedAt: CreationOptional<Date>;
}

export function initBlockProgress(seq: Sequelize): void {
  BlockProgress.init(
    {
      chainKey: { type: DataTypes.STRING(64), primaryKey: true },
      lastSeenBlock: { type: DataTypes.INTEGER, allowNull: false },
      updatedAt: DataTypes.DATE,
    },
    { sequelize: seq, tableName: 'block_progress', underscored: true, timestamps: true, createdAt: false },
  );
}
