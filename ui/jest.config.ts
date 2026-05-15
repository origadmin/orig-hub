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
    '^wailsjs/go/(.*)$': '<rootDir>/src/test/__mocks__/wailsGo.js',
    '^wailsjs/runtime/(.*)$': '<rootDir>/src/test/__mocks__/wailsRuntime.js',
    '\\.(css|less|scss|sass)$': '<rootDir>/src/test/__mocks__/style.js',
  },
  setupFiles: ['<rootDir>/src/test/setup.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/test/setupAfterFramework.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
}

export default config
