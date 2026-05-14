import type { Config } from 'jest'

const config: Config = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.{test,spec}.{ts,tsx}'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      diagnostics: {
        exclude: ['**'],
      },
    }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^wailsjs/(.*)$': '<rootDir>/wailsjs/$1',
    '\\.(css|less|scss|sass)$': '<rootDir>/src/test/__mocks__/style.js',
  },
  setupFiles: ['<rootDir>/src/test/setup.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/test/setupAfterFramework.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
}

export default config
