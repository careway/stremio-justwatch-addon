# Postgres for the Jetson Nano (arm64). Adds a self-signed TLS cert generated
# on first boot (so it covers whatever DuckDNS hostname you configure) and a
# pg_hba.conf that requires SSL + scram-sha-256 for every remote connection.
FROM postgres:18-alpine

# The alpine image ships libssl but not the openssl CLI, which the entrypoint
# below needs to generate the self-signed cert.
RUN apk add --no-cache openssl

COPY pg_hba.conf /etc/postgresql/pg_hba.conf
COPY docker-entrypoint-ssl.sh /usr/local/bin/docker-entrypoint-ssl.sh
RUN chmod +x /usr/local/bin/docker-entrypoint-ssl.sh

ENTRYPOINT ["docker-entrypoint-ssl.sh"]
CMD ["postgres", \
     "-c", "listen_addresses=*", \
     "-c", "ssl=on", \
     "-c", "ssl_cert_file=/var/lib/postgresql/certs/server.crt", \
     "-c", "ssl_key_file=/var/lib/postgresql/certs/server.key", \
     "-c", "password_encryption=scram-sha-256", \
     "-c", "hba_file=/etc/postgresql/pg_hba.conf"]
