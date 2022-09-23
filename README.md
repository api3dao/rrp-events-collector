# RRP Events Collector

The RRP events collector is a serverless application which collects Airnode RRP (V0) protocol related events from the
configured chains and stores them in a Postgres database.

## Deployment

Most of the services in this repository rely on a Postgres database. In the current infrastructure the database is
hosted on an EC2 instance behind a "Load Balancer" called Traefik.

Traefik uses LetsEncrypt to encrypt database connectivity, which prevents eavesdropping and man-in-the-middle attacks.

Traefik relies on [SNI](https://en.wikipedia.org/wiki/Server_Name_Indication) to know how to forward TCP connections
(which is also a security feature as if you don't know the hostname you can't access the database). The Postgres driver
for Typescript doesn't currently support SNI directly, and so we set up a custom TCP socket for this in our
database-reliant applications.

AWS credentials should be exported as environment variables and both `config/config.json` and `serverless.yml` should be
populated prior to running the following commands:

```bash
# Test your installation with
yarn sls invoke local --function functionName
```

API3 stores the current active deployment files (`config.json` and `serverless.yml`) in Keybase. You can easily retrieve
these files and place them in the appropriate directories:

- /config/config.json
- /serverless.yml

With this config in place you can deploy:

```bash
yarn sls:deploy
```

Be sure to watch the logs to make sure the applications are behaving as you expect.
