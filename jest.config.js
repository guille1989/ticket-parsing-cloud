module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest']
  },
  // El código fuente usa imports estilo NodeNext ESM (ej. "../money.js"),
  // pero Jest resuelve en modo CJS y no hay ningún "money.js" real, solo
  // "money.ts" — esto le dice al resolver que pruebe sin el ".js" cuando
  // el import es relativo.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
