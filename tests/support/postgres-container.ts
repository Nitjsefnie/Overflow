import { GenericContainer, Wait, type StartedTestContainer, type WaitStrategy } from "testcontainers";

export interface PostgresContainerOptions {
  database: string;
  user: string;
  password: string;
  /** Optional shell scripts copied into /docker-entrypoint-initdb.d/ before start. Test fixtures only. */
  initScripts?: ReadonlyArray<{ name: string; content: string }>;
}

export interface StartedPostgres {
  container: StartedTestContainer;
  /** postgresql://user:password@host:mappedPort/database */
  databaseUrl: string;
}

export const POSTGRES_IMAGE = "postgres:17-alpine";

/**
 * The official postgres entrypoint runs initialisation against a temporary server bound to a Unix
 * socket only, so a wait strategy that reaches postgres over that socket passes while nothing is
 * listening on TCP 5432 yet. `forListeningPorts` holds until a real listener exists, and
 * `pg_isready --host 127.0.0.1` is forced over TCP, exiting nonzero until connections are accepted.
 */
export function postgresWaitStrategy({ database, user }: Pick<PostgresContainerOptions, "database" | "user">): WaitStrategy {
  return Wait.forAll([
    Wait.forListeningPorts(),
    Wait.forSuccessfulCommand(`pg_isready --host 127.0.0.1 --username ${user} --dbname ${database}`),
  ]);
}

export async function startPostgresContainer(options: PostgresContainerOptions): Promise<StartedPostgres> {
  const { database, user, password, initScripts = [] } = options;

  let container = new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_DB: database,
      POSTGRES_PASSWORD: password,
      POSTGRES_USER: user,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(postgresWaitStrategy({ database, user }));

  for (const { name, content } of initScripts) {
    container = container.withCopyContentToContainer([
      { content, target: `/docker-entrypoint-initdb.d/${name}`, mode: 0o755 },
    ]);
  }

  const started = await container.start();

  return {
    container: started,
    databaseUrl: `postgresql://${user}:${password}@${started.getHost()}:${started.getMappedPort(5432)}/${database}?client_min_messages=warning`,
  };
}
