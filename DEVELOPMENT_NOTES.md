# Development Notes

When testing locally you may want to test against a local _throwaway_ database.

An easy way of doing this is to launch a local Postgres instance:

```shell
docker run -ti --rm -p 5432:5432 -e POSTGRES_PASSWORD=password postgres
```

This command:

- `-ti` starts the command in the foreground (interactive with terminal/tty)
- `--rm` removes the container when it exits (all data is removed except the image)
- `-p 5432:5432` exposes the database's port to all interfaces/listens
- `-e POSTGRES_PASSWORD=password` causes the container's init script to initialise the database postgres user with this
  password.
- `postgrs` the name of the image, defaults to `latest`

Missing tables are automatically created.

An example `serverless.yml` file that will use this database looks like this:

```yaml
service: rrp-events-220705

plugins:
  - serverless-plugin-typescript

variablesResolutionMode: 20210326

package:
  patterns:
    - ./config/config.json

provider:
  name: aws
  region: us-east-1
  stage: c
  runtime: nodejs16.x
  architecture: arm64
  lambdaHashingVersion: 20201221
  logRetentionInDays: 7
  environment:
    OPSGENIE_API_KEY: 'a-UUID-key'
    POSTGRES_USER: 'postgres'
    POSTGRES_PASSWORD: 'password'
    POSTGRES_DATABASE: 'postgres'
    POSTGRES_HOST: '127.0.0.1'
    # SSL omitted
    CONFIG: 'config.json'
    DEBUG: 1
```

You can invoke the main collector with this command:

```shell
rm -rf .build .serverless && yarn sls invoke local -f rrp_collection_handler
```

We use [SNI-based routing]() for our internet-facing Postgres databases. Node on Windows and Mac OS does not correctly
handle certificates for this system, but Stunnel does.

Stunnel is a utility that wraps plain-text communication in an SSL channel (you could use it to do HTTP->HTTPS for
example).

To use Stunnel on Mac OS with Homebrew:

```shell
brew install stunnel
```

then populate a `stunnel.conf` file:

```shell
foreground = yes
debug = info
;output = /usr/local/var/log/stunnel.log

[main-postgres]
client = yes
accept = 127.0.0.1:65432
connect = youll-have-to-ask-for-this.api3data.link:65432
```

then run Stunnel in the foreground during development:

```shell
stunnel stunnel.conf
```

Your `serverless.yml` will then look like this:

```yaml
service: rrp-collector-220705

plugins:
  - serverless-plugin-typescript

variablesResolutionMode: 20210326

package:
  patterns:
    - ./config/config.json

provider:
  name: aws
  region: us-east-1
  stage: c
  runtime: nodejs16.x
  architecture: arm64
  lambdaHashingVersion: 20201221
  logRetentionInDays: 7
  environment:
    OPSGENIE_API_KEY: 'a-UUID-key'
    POSTGRES_USER: 'a-user'
    POSTGRES_PASSWORD: 'a-password'
    POSTGRES_DATABASE: 'a-database-schema'
    POSTGRES_HOST: '127.0.0.1'
    CONFIG: 'config.json'
    DEBUG: 1
```
