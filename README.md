# raven

The raven framework is an abstraction layer for NodeJS applications
that need to communicate with the Global ECCO game lobby.  That lobby is
a work in progress, so this is too.

Examples that use this framework are the Guerrilla Checkers, Infochess
and Asymmetric Warfare.

You depend on Raven after the typical NodeJS fashion, by making this
repository a dependency in the package.json file of your game.


## Lobby Simulator

Raven has a stub that simulates the game lobby that
will eventually be presenting your game to the community.  This is
called the 'liferay-stub' because the first versions of the lobby were
implemented as a plugin for the Liferay portal platform.

In your game project, Raven is a node dependency, so you find
its files in your game project's 'node_modules' directory.  Normally
you don't have to do anything with these files directly, they are just
a library your game calls upon to interact with the lobby. But the stub
is a node application that you can run directly from the game project.

To run the stub from the game project, you simply invoke node
with the raven app right where it sits in your 'node_modules'
directory.

```node node_modules/raven/liferay_stub.js```
   
Then, follow the example in, e.g., Guerrilla Checkers, to run the
game in a configuration that uses the stub instead of a real 
instance of the lobby.  This is pretty much
just a matter of setting the ENV for the game:

```
EGS_HOST="localhost" # if running the liferay stub, use localhost
EGS_PORT="4000" # if running the liferay stub, it listens on this port
EGS_USERNAME="ask someone" # not needed for liferay stub
EGS_PASSWORD="ask someone" # not needed for liferay stub
```



