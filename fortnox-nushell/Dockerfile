FROM archlinux
RUN pacman -Sy --noconfirm --needed base-devel nushell git
RUN git clone https://github.com/joaqim/nushell-modules /opt/nushell-modules
COPY .env.nu /opt/nushell-modules/fortnox_client/.env.nu

ADD ./nushell-config/ /root/

WORKDIR /context

# Create a non-root user
RUN useradd -m build
RUN chown -R build:build /context

USER build
RUN git clone https://aur.archlinux.org/mongosh-bin.git
ENV MAKEFLAGS="-j$(nproc)"
ENV PKGEXT=".pkg.tar"
RUN cd mongosh-bin && makepkg -src

USER root
RUN find /context -name "*.pkg.tar" -exec pacman -U --noconfirm {} \;

WORKDIR /root

#ENTRYPOINT ["/usr/bin/nu", "-c"]