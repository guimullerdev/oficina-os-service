module.exports = {
  default: {
    paths: ['features/**/*.feature'],
    require: ['features/**/*.ts'],
    requireModule: ['ts-node/register', 'tsconfig-paths/register'],
    format: ['progress', 'summary'],
  },
};
