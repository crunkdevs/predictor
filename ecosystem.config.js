module.exports = {
  apps: [
    {
      name: 'predictor-app',
      script: 'server.v2.js',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Shanghai',
        SCHEDULER_TZ: 'Asia/Shanghai',
        CRON_SCHEDULE_V2: '0 * * * * *',
      },
    },
  ],
};
